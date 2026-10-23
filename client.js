/**
 * dsh-baleen —— 客户端半
 *
 * 以 dsh.client bundle 格式加载（宿主 ModuleLoader 直接吃单文件，无打包器）。
 * 注册 id 必须等于 loader entry 名（dsh-baleen），否则宿主报
 *   "loaded without registering dsh-baleen"。
 *
 * 视觉约定：一个硬编码颜色都没有 —— 只消费 --dsw-alias-* / --dsw-static-*，
 * fallback 用 light-dark() 同时给明暗两值。换主题时这里自动跟着变，
 * 是「融进主题」而不是「自带一套皮肤」。
 *
 * 挂载点（M2）：
 *   sidebar.panellist → 左侧栏入口，id 与 main 的 key 同为 baleen（不同名宿主会抛）
 *   main              → 整页面板：顶部五项导航 + 视图 + 抽屉
 * 设置页 settings.section 在 M5 才注册，本里程碑不挂。
 */
window.__ModuleLoader__.load({
  id: 'dsh-baleen',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'baleen'
    /** 视图状态存这个键，数据快照存 SNAPSHOT_KEY（view-api 里）——两份别混 */
    const VIEW_KEY = 'baleen.view'
        // ---- src/client/view-state.js ----
    /**
     * 面板视图状态。纯函数，不碰 window、不发请求——所以能在 Node 里测完。
     * 每个视图的筛选各存各的：从视频区带着"档位=值得看"切去文章区，
     * 回来时那个筛选还在，但不会污染文章区的筛选。
     */
    const VIEWS = ['today', 'video', 'article', 'digest', 'library']

    const DEFAULT_STATE = () => ({ view: 'today', filters: {}, drawerItemId: null, scroll: 0 })

    /** 首屏状态。持久化的读法在 decodeState（装配层把 localStorage 里的原文交给它）。 */
    function initialView() {
      return decodeState()
    }

    function reduce(state, action) {
      const s = state ?? DEFAULT_STATE()
      switch (action?.type) {
        case 'pick-view':
          return VIEWS.includes(action.view) ? { ...s, view: action.view } : s
        case 'filter': {
          if (!action.view || !action.key) return s
          const perView = { ...(s.filters[action.view] ?? {}) }
          if (action.value === '' || action.value === null || action.value === undefined) delete perView[action.key]
          else perView[action.key] = action.value
          return { ...s, filters: { ...s.filters, [action.view]: perView } }
        }
        case 'open-drawer':
          return action.id == null ? s : { ...s, drawerItemId: action.id }
        case 'close-drawer':
          return { ...s, drawerItemId: null }
        case 'scroll':
          return { ...s, scroll: Number(action.top) || 0 }
        default:
          return s
      }
    }

    function encodeState(state) {
      try {
        return JSON.stringify({ v: 1, view: state.view, filters: state.filters, drawerItemId: state.drawerItemId, scroll: state.scroll })
      } catch { return '' }
    }

    /**
     * localStorage 里可能是上次崩溃留下的半成品、也可能是旧版本写的结构，
     * 所以一律回落默认而不是抛——抛在 apply() 里会炸整个客户端装配。
     */
    function decodeState(text) {
      const base = DEFAULT_STATE()
      if (!text) return base
      let obj
      try { obj = JSON.parse(text) } catch { return base }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return base
      const filters = {}
      if (obj.filters && typeof obj.filters === 'object' && !Array.isArray(obj.filters)) {
        for (const [k, v] of Object.entries(obj.filters)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) filters[k] = { ...v }
        }
      }
      return {
        view: VIEWS.includes(obj.view) ? obj.view : base.view,
        filters,
        drawerItemId: Number.isInteger(obj.drawerItemId) ? obj.drawerItemId : null,
        scroll: Number.isFinite(obj.scroll) ? obj.scroll : 0
      }
    }

    // ---- src/client/view-api.js ----
    /**
     * 面板取数层。三条规矩：
     *  1. 失败绝不抛到渲染层——回 `{ ok:false, stale:true, data:上次快照 }`，顶栏据此出灰条；
     *  2. 快照只存"能渲染的状态"，不存正文（真相在 sqlite 里，快照是为了宿主没起来时不白屏）；
     *  3. feedback 的动作是白名单，不接收调用方传来的 delta——
     *     否则一个坏掉的（或被改过的）前端就能把来源权重推到任意值。
     */
    const API_BASE = '/api/dsh-baleen'

    const SNAPSHOT_KEY = 'baleen.snapshot'

    function createApi({ fetch: fetchImpl = globalThis.fetch, storage = globalThis.localStorage, actions = { dismiss: -0.1, save: 0.1 } } = {}) {
      function write(obj) {
        try { storage.setItem(SNAPSHOT_KEY, JSON.stringify(obj)) } catch { /* 隐私模式或配额满，记不上就算了 */ }
      }
      function readCached() {
        try {
          const t = storage.getItem(SNAPSHOT_KEY)
          const p = t ? JSON.parse(t) : null
          return p && typeof p === 'object' && !Array.isArray(p) ? p : null
        } catch { return null }
      }
      async function call(url, init) {
        try {
          const res = await fetchImpl(url, init)
          if (!res || res.ok === false) throw new Error('HTTP ' + ((res && res.status) ?? '?'))
          return { json: await res.json(), httpOk: true }
        } catch (e) {
          return { error: String((e && e.message) || e) }
        }
      }
      async function get(url) {
        const r = await call(url, { cache: 'no-store' })
        if (r.httpOk) { write(r.json); return { ok: true, stale: false, data: r.json } }
        return { ok: false, stale: true, data: readCached(), error: r.error }
      }

      return {
        snapshot: readCached,
        state: () => get(API_BASE + '/state'),
        items: (q = {}) => get(API_BASE + '/items?' + new URLSearchParams(q).toString()),
        async run() {
          const r = await call(API_BASE + '/run', { method: 'POST' })
          if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
          const next = r.json && r.json.state ? r.json.state : r.json
          if (next) write(next)
          return { ok: true, stale: false, data: r.json }
        },
        async feedback(sourceId, action) {
          if (!Object.prototype.hasOwnProperty.call(actions, action)) throw new Error('未知动作：' + action)
          if (!sourceId) throw new Error('feedback 需要 source_id')
          const r = await call(API_BASE + '/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source_id: sourceId, action })
          })
          if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
          return { ok: true, stale: false, data: r.json }
        }
      }
    }

    // ---- src/client/vnode.js ----
    /**
     * 视图产出的节点形状：{type, props, children}，纯数据。
     *
     * 视图不直接调 React.createElement，是为了能在 Node 里把渲染结果当普通对象断言
     * （test/helpers/tree.mjs 压文本、tools/preview.mjs 出静态 HTML 都吃这个形状）。
     * 装配层用 toElement() 把这棵树交给真 React。
     */
    const vnode = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })

    // ---- src/client/match.js ----
    /**
     * 命中理由的读法。预筛入库时把"为什么给你这条"写进 items.match_json，
     * 面板只读不改；坏 JSON 与缺字段一律显示"（无理由）"——留空看起来像"没有理由"，
     * 而真实情况是"这条没写下理由"，两者不能混。
     */
    function reasonOf(item) {
      try {
        const m = JSON.parse(item?.match_json ?? '{}')
        return typeof m.reason === 'string' && m.reason ? m.reason : '（无理由）'
      } catch { return '（无理由）' }
    }

    // ---- src/client/views/today.js ----
    /**
     * 「今天」= 门户头版。这一屏承担全部的诚实责任：
     * 过筛多少、候选多少、待判多少、为什么被丢、哪个源挂了，都得看得见。
     * 纯函数：数据从参数进，不读 window、不发请求。
     */
    const GAP_LABELS = {
      'theme-reject': '命中排除词',
      'no-body': '读不到内容',
      stale: '超龄',
      'too-short': '时长过短',
      'skip-kind': '形态被跳过',
      'below-score': '得分不够',
      'no-match': '没命中主题'
    }
    const FLAG_LABELS = { burned_in: '硬字幕读不到', missing: '无语音' }

    const REASONS_READABLE = GAP_LABELS

    const n = (v) => Number(v) || 0

    function summaryLine(state) {
      const c = state?.counts ?? {}
      const run = state?.last_run
      const head = run
        ? `上一轮 ${run.status === 'done' ? '跑完' : run.status === 'partial' ? '部分源失败' : '失败'} · 过筛 ${n(c.total)} → 候选 ${n(run.candidates)} → 待判 ${n(c.new)}`
        : `库里 ${n(c.total)} 条 · 还没有跑过一轮`
      return `${head}｜已判 ${n(c.judged) + n(c.digest)}`
    }

    function gapText(gaps) {
      const by = gaps?.by_reason ?? {}
      const flags = gaps?.kept_with_flag ?? {}
      if (!Object.keys(by).length && !Object.keys(flags).length) return '（还没有一轮记录）'
      const parts = Object.entries(by).map(([k, v]) => `${GAP_LABELS[k] ?? k} ${v}`)
      const kept = Object.entries(flags).map(([k, v]) => `${FLAG_LABELS[k] ?? k} ${v}`)
      return [`丢弃 ${n(gaps.total_dropped)}`, ...parts, ...(kept.length ? [`保留待读：${kept.join(' / ')}`] : [])].join(' · ')
    }

    function sourceIssues(state) {
      return (state?.sources ?? []).filter((s) => s.ok === false).map((s) => ({
        id: s.id,
        text: s.error_class === 'needs_login' ? `${s.id} 需要重新登录`
          : s.error_class === 'unavailable' ? `${s.id} 缺依赖，去设置页装`
            : s.error_class === 'empty' ? `${s.id} 本轮取到 0 条`
              : `${s.id} 本轮失败（${s.error_class ?? '未知'}），游标没推进，下轮自动补`
      }))
    }

    function Card({ item, onOpen }) {
      return vnode('button', { type: 'button', className: 'bl-card' + (item.kind === 'video' ? ' is-video' : ''), onClick: () => onOpen?.(item.id) }, [
        item.kind === 'video' ? vnode('span', { className: 'bl-thumb' }, [vnode('span', { className: 'bl-dur' }, [item.duration_sec ? String(item.duration_sec) : '—'])]) : null,
        vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
        vnode('span', { className: 'bl-card-meta' }, [item.source_id, item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章']),
        vnode('span', { className: 'bl-tier' }, [item.verdict_tier ? `已判：${item.verdict_tier}` : '待判']),
        vnode('span', { className: 'bl-why' }, [reasonOf(item)])
      ].filter(Boolean))
    }

    function TodayView({ state, items = [], onPickView, onOpen, onRun, busy }) {
      const videos = items.filter((i) => i.kind === 'video')
      const writings = items.filter((i) => i.kind !== 'video')
      const pending = n(state?.counts?.new)
      const issues = sourceIssues(state)

      return vnode('div', { className: 'bl-today' }, [
        vnode('div', { className: 'bl-summary' }, [summaryLine(state)]),
        vnode('div', { className: 'bl-gaps' }, [gapText(state?.gaps)]),
        issues.length ? vnode('div', { className: 'bl-issues', role: 'status' }, issues.map((s) => s.text)) : null,
        vnode('div', { className: 'bl-pending' }, [
          pending
            ? `待判 ${pending} 条——判断由会话来做，说一句"把今天的候选判一下"就行（M3 接入后这里会自动提示）`
            : '没有待判条目'
        ]),
        vnode('div', { className: 'bl-actions' }, [
          vnode('button', { type: 'button', disabled: Boolean(busy), onClick: () => onRun?.() }, [busy ? '跑着…' : '现在跑一轮']),
          vnode('button', { type: 'button', onClick: () => onPickView?.('library') }, ['去库'])
        ]),
        vnode('section', { className: 'bl-rail' }, [
          vnode('h3', {}, [`视频区 · ${videos.length}`]),
          videos.length ? vnode('div', { className: 'bl-grid' }, videos.map((it) => Card({ item: it, onOpen })))
            : vnode('p', { className: 'bl-empty' }, ['这个库里还没有视频。B 站 / 小红书视频笔记在 M4 接入。'])
        ]),
        vnode('section', { className: 'bl-rail' }, [
          vnode('h3', {}, [`文章区 · ${writings.length}`]),
          writings.length ? vnode('div', { className: 'bl-grid' }, writings.map((it) => Card({ item: it, onOpen })))
            : vnode('p', { className: 'bl-empty' }, ['文章区是空的。可能是刚清过库，或者筛选把东西都丢了。'])
        ])
      ].filter(Boolean))
    }

    // ---- src/client/views/video.js ----
    /**
     * 「视频」视图。这一屏的诚实点在两处：
     *  1. 档位只有三个词，没判过的就是"待判"，不许用预筛得分冒充结论；
     *  2. 能不能播按源说清楚——只有 B 站打算内嵌，其余一律跳转，不画播放键骗人。
     */

    const TIER_LABELS = { '值得看': 'good', '可以看': 'ok', '不值当': 'bad' }
    const STATE_LABELS = {
      full: '全文', summary_only: '仅摘要', subtitle: '字幕',
      transcribed: '转写', missing: '无语音', burned_in: '硬字幕读不到'
    }

    function fmtDuration(sec) {
      const s = Number(sec)
      if (!Number.isFinite(s) || s <= 0) return ''
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const r = Math.floor(s % 60)
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
    }

    function visibleVideos(items, filters = {}) {
      const q = String(filters.q ?? '').trim().toLowerCase()
      return (items ?? []).filter((i) => i.kind === 'video')
        .filter((i) => !filters.tier || i.verdict_tier === filters.tier)
        .filter((i) => !filters.source || i.source_id === filters.source)
        .filter((i) => !q || `${i.title ?? ''} ${i.author ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
    }

    function Picker({ label, filterKey, view, options, value, onFilter }) {
      return vnode('select', {
        'aria-label': label,
        value: value ?? '',
        onChange: (e) => onFilter?.({ view, key: filterKey, value: e?.target?.value ?? '' })
      }, [
        vnode('option', { value: '' }, [`${label}：全部`]),
        ...options.map((o) => vnode('option', { key: o, value: o }, [o]))
      ])
    }

    function VideoCard({ item, onOpen }) {
      return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
        vnode('span', { className: 'bl-thumb' }, [vnode('span', { className: 'bl-dur' }, [fmtDuration(item.duration_sec) || '—'])]),
        vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
        vnode('span', { className: 'bl-card-meta' }, [
          item.author || item.source_id,
          STATE_LABELS[item.body_state] ?? item.body_state ?? ''
        ]),
        vnode('span', { className: 'bl-tier' }, [item.verdict_tier ? `${item.verdict_tier}：${item.verdict_why || '（这条没写理由）'}` : '待判']),
        vnode('span', { className: 'bl-why' }, [reasonOf(item)]),
        vnode('span', { className: 'bl-play' }, [item.source_id === 'bili' ? '可在抽屉内播' : '只能跳转'])
      ])
    }

    function VideoView({ items = [], filters = {}, onFilter, onOpen }) {
      const all = (items ?? []).filter((i) => i.kind === 'video')
      const list = visibleVideos(items, filters)
      const sources = [...new Set(all.map((i) => i.source_id))]
      const judged = list.filter((i) => i.status === 'judged').length

      return vnode('div', { className: 'bl-video' }, [
        vnode('div', { className: 'bl-toolbar' }, [
          Picker({ label: '档位', filterKey: 'tier', view: 'video', options: Object.keys(TIER_LABELS), value: filters.tier, onFilter }),
          Picker({ label: '平台', filterKey: 'source', view: 'video', options: sources, value: filters.source, onFilter }),
          vnode('input', {
            type: 'search', 'aria-label': '关键词', placeholder: '在这批视频里找',
            value: filters.q ?? '',
            onChange: (e) => onFilter?.({ view: 'video', key: 'q', value: e?.target?.value ?? '' })
          })
        ]),
        vnode('div', { className: 'bl-count' }, [`显示 ${list.length} / ${all.length} 条（判过 ${judged} 条）`]),
        list.length
          ? vnode('div', { className: 'bl-grid' }, list.map((i) => VideoCard({ item: i, onOpen })))
          : vnode('div', { className: 'bl-empty' }, [all.length
            ? '这个筛选下没有东西。库里有货但没显示出来时，通常是档位或平台筛过了——把筛选清一下。'
            : '库里还没有视频。B 站与小红书视频笔记在 M4 接入；现在订阅的都是文章源的话，这里就该是空的。'])
      ])
    }

    // ---- src/client/views/placeholder.js ----
    /**
     * 未接入视图的占位渲染器。规则是"不许把没有的画成有"：
     * 每一段文案都要点名是哪个里程碑，且不能出现任何看起来像真内容的东西
     * （不放假标题、不放假简报）。后续任务换真实现时，要把对应的导出从这里删掉——
     * 留着就是两份同名实现，迟早漂移。
     */

    function Placeholder({ view, why }) {
      return vnode('div', { className: 'bl-empty-state' }, [`${why}（${view}）`])
    }

    const ArticleView = () => Placeholder({ view: 'M2 文章区任务', why: '文章区还没接上真渲染器' })
    const DigestView = () => Placeholder({ view: 'M3 判断轮', why: '判断轮未接入，所以这里没有图文汇报' })
    const LibraryView = () => Placeholder({ view: 'M2 库任务', why: '库还没接上真渲染器' })
    const Drawer = () => null


    function NotReady({ text }) {
      return h('div', { className: 'bl-empty' }, text)
    }

    function Nav({ view, onPick, pending }) {
      const items = [['today', '今天'], ['video', '视频'], ['article', '文章'], ['digest', '汇报'], ['library', '库']]
      return h('nav', { className: 'bl-nav', 'aria-label': '主导航' }, [
        h('span', { className: 'bl-brand', key: 'b' }, 'Baleen'),
        h('div', { className: 'bl-navlist', key: 'n' }, items.map(([id, label]) =>
          h('button', {
            type: 'button',
            key: id,
            className: 'bl-navitem',
            'aria-current': view === id ? 'page' : 'false',
            onClick: () => onPick?.(id)
          }, label + (id === 'today' && pending ? ` ·待判${pending}` : ''))
        ))
      ])
    }

    /**
     * 视图只产 {type, props, children} 这种纯数据（不碰 React，才能在 Node 里断言），
     * 这里负责把整棵树交给 createElement。列表补 index key：宿主开发模式会因缺 key 刷屏警告。
     */
    function toElement(node, key) {
      if (node == null || node === false || node === true) return null
      if (Array.isArray(node)) return node.map((n, i) => toElement(n, (n && n.props && n.props.key) ?? i)).filter(Boolean)
      if (typeof node !== 'object' || !('type' in node)) return node
      const props = { ...(node.props ?? {}) }
      if (props.key == null && key !== undefined) props.key = key
      const kids = (node.children ?? []).map((c, i) => toElement(c, (c && c.props && c.props.key) ?? i)).filter(Boolean)
      return h(node.type, props, ...kids)
    }

    /** 全局异常带：偏好文件坏了 / 接口没答上 / 手动那轮失败。没问题时这一格不渲染。 */
    function TopBar({ stale, runError, preferenceErrors }) {
      const bits = []
      if (preferenceErrors && preferenceErrors.length) {
        bits.push(`偏好文件有 ${preferenceErrors.length} 处问题：${preferenceErrors.slice(0, 2).join('；')}`)
      }
      if (stale) bits.push('宿主接口没答上，下面是上次成功时的快照')
      if (runError) bits.push('这一轮没跑成：' + runError)
      if (!bits.length) return null
      return h('div', { className: 'bl-band', role: 'alert' }, bits.map((b, i) => h('span', { key: i }, b)))
    }

    let clientCtx = null
    const inject = ['slots', 'layout']

    /** 只有声明过的服务读得到；这条 helper 存在的意义就是不让人手写裸属性回退 */
    function safeGet(name) {
      if (!clientCtx) return undefined
      try {
        return typeof clientCtx.get === 'function' ? clientCtx.get(name) : undefined
      } catch { return undefined }
    }

    function getLayout() {
      // ctx 是 Proxy：get 会抛，属性访问也会抛。两层都得包。
      const viaGet = safeGet('layout')
      if (viaGet) return viaGet
      try { return (clientCtx && clientCtx.layout) || null } catch { return null }
    }

    /** 导航项 ↔ 渲染器。VIEW_RENDER 的键必须与 view-state 的 VIEWS 一字不差（测试守着）。 */
    const VIEW_RENDER = { today: TodayView, video: VideoView, article: ArticleView, digest: DigestView, library: LibraryView }

    /** 面板里"活着"的条目：归档的只在「库」里看。一次 IN 查询，不靠多次请求拼。 */
    const LIVE_STATUS = 'new,judged,digest'

    function Panel() {
      // api 与首屏状态都得只建一次：useState 的惰性初始化是唯一入口（useMemo 在桩里等价于直接调）
      const [api] = React.useState(() => createApi({ fetch: globalThis.fetch, storage: globalThis.localStorage }))
      const [snap, setSnap] = React.useState(() => decodeState(globalThis.localStorage && globalThis.localStorage.getItem(VIEW_KEY)))
      const [data, setData] = React.useState({ state: null, items: [], stale: false })
      const [busy, setBusy] = React.useState(false)
      const [runError, setRunError] = React.useState('')

      const pickView = (v) => dispatch({ type: 'pick-view', view: v })
      function dispatch(action) {
        const next = reduce(snap, action)
        setSnap(next)
        try { globalThis.localStorage.setItem(VIEW_KEY, encodeState(next)) } catch { /* 存不上不影响这一屏 */ }
      }

      // 「库」要看得归档条目，所以它的查询不限状态；其余三格只要活着的那些。
      const query = (view) => (view === 'library' ? { limit: 500 } : { status: LIVE_STATUS, limit: 200 })
      function refresh(view = snap.view) {
        return Promise.all([api.state(), api.items(query(view))])
          .then(([s, it]) => setData({ state: s.data, items: (it.data && it.data.items) || [], stale: !s.ok }))
      }
      React.useEffect(() => { refresh() }, [snap.view])

      function onRun() {
        setBusy(true)
        setRunError('')
        api.run()
          .then((r) => { if (!r.ok) setRunError(r.error || '未知错误'); return refresh() })
          .finally(() => setBusy(false))
      }

      const view = snap.view
      const st = data.state
      const pending = (st && st.counts && st.counts.new) || 0
      const render = VIEW_RENDER[view]
      const body = render({
        state: st,
        items: data.items,
        filters: snap.filters[view] || {},
        busy,
        onRun,
        onFilter: dispatch,
        onOpen: (id) => dispatch({ type: 'open-drawer', id }),
        onPickView: pickView
      })
      return h('div', { className: 'bl-root' }, [
        h(TopBar, { key: 'bar', stale: data.stale, runError, preferenceErrors: st && st.preference_errors }),
        h(Nav, { key: 'nav', view, pending, onPick: pickView }),
        h('main', { key: 'body', className: 'bl-body' }, toElement(body)),
        snap.drawerItemId
          ? toElement(Drawer({ id: snap.drawerItemId, items: data.items, api, onClose: () => dispatch({ type: 'close-drawer' }) }))
          : null
      ])
    }

    function apply(ctx) {
      clientCtx = ctx
      const slots = safeGet('slots')
      if (!slots) {
        console.error('[dsh-baleen] 拿不到 slots 服务，界面不注册')
        return { registeredSlots: [] }
      }
      const registered = []

      const reg = (slot, meta, render, where) => {
        try {
          slots.inject(slot, () => {
            const def = slots.register(meta, (...args) => {
              try {
                return render(...args)
              } catch (e) {
                // 某一格炸了不该白屏：吃掉它并留下可读线索，宿主日志里也拿得到
                console.error('[dsh-baleen] ' + where + ' 渲染抛错：' + ((e && e.message) || e))
                return h(NotReady, { text: '这一格渲染失败：' + where })
              }
            })
            registered.push({ slot, def })
            return def
          })
        } catch (e) {
          console.error('[dsh-baleen] 槽位注册失败 ' + where + '：' + ((e && e.message) || e))
        }
      }

      reg('sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: 'Baleen' },
        () => h('span', { className: 'bl-icon', 'aria-hidden': 'true' }, '≈'),
        'sidebar.panellist')

      // main 的 key 必须与侧栏 id 同名，否则宿主 layout.selectPanel 抛
      reg('main', { name: 'main', key: PANEL_ID }, () => h(Panel, { key: 'panel' }), 'main')

      return { registeredSlots: registered }
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      PANEL_ID, VIEW_KEY, API_BASE, SNAPSHOT_KEY, VIEWS, VIEW_RENDER,
      Nav, NotReady, TopBar, Panel, toElement, createApi, getLayout, safeGet,
      reduce, encodeState, decodeState, TodayView
    }
    return module.exports
  }
})
