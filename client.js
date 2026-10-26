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
    const VIEWS = ['today', 'video', 'article', 'collections', 'digest', 'library']

    const DEFAULT_STATE = () => ({ view: 'today', filters: {}, drawerItemId: null, selectedId: null, scroll: 0 })

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
        case 'facet': {
          // 「库」的多选筛选：组内 OR，勾满再取消就删键（等价于"不筛"），不留空数组占位
          if (!action.view || !action.key || action.value == null) return s
          const perView = { ...(s.filters[action.view] ?? {}) }
          const cur = Array.isArray(perView[action.key]) ? perView[action.key] : []
          const next = action.on ? [...new Set([...cur, action.value])] : cur.filter((v) => v !== action.value)
          if (next.length) perView[action.key] = next
          else delete perView[action.key]
          return { ...s, filters: { ...s.filters, [action.view]: perView } }
        }
        case 'open-drawer':
          return action.id == null ? s : { ...s, drawerItemId: action.id }
        case 'select': {
          const id = action.id == null ? null : Number(action.id)
          return { ...s, selectedId: Number.isInteger(id) ? id : null }
        }
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
        return JSON.stringify({ v: 1, view: state.view, filters: state.filters, drawerItemId: state.drawerItemId, selectedId: state.selectedId, scroll: state.scroll })
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
        selectedId: Number.isInteger(obj.selectedId) ? obj.selectedId : null,
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

      /**
       * 写请求专用。与 get() 的分别：4xx/5xx 也要把响应体读出来——
       * folder_gone 带的是"哪几个夹没了"，丢了就等于面板只能说"没记上"，
       * 而用户真正需要知道的是那个夹已经被删了，换个夹再收一次。
       */
      async function post(urlPath, payload) {
        return send('POST', urlPath, payload)
      }

      /** 设置页的 PUT（preference / credential）：与 post 同一套"错误体也要读回来"的规矩。 */
      async function put(urlPath, payload) {
        return send('PUT', urlPath, payload)
      }

      async function send(method, urlPath, payload) {
        try {
          const res = await fetchImpl(API_BASE + urlPath, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })
          const status = (res && res.status) ?? 0
          let json = null
          try { json = res && await res.json() } catch { json = null }
          if (res && res.ok === false) {
            return {
              ok: false,
              error: (json && json.error) || ('HTTP ' + status),
              missing: (json && json.missing) || undefined,
              data: json
            }
          }
          return { ok: true, stale: false, data: json }
        } catch (e) {
          return { ok: false, stale: true, error: String((e && e.message) || e), data: null }
        }
      }

      /**
       * 设置页的只读 GET。绝不走 get()：那会把应答写进共享快照（baleen.snapshot），
       * 而 /state 的失败回落靠的是它——preference 的应答盖上去，面板顶栏就会
       * 拿偏好数据冒充面板状态。
       */
      async function plainGet(urlPath) {
        try {
          const res = await fetchImpl(API_BASE + urlPath, { cache: 'no-store' })
          if (!res || res.ok === false) return { ok: false, stale: true, data: null }
          return { ok: true, stale: false, data: await res.json() }
        } catch { return { ok: false, stale: true, data: null } }
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
        },
        folders: async () => {
          try {
            const res = await fetchImpl(API_BASE + '/folders', { cache: 'no-store' })
            if (!res || res.ok === false) return { ok: false, stale: true, data: null }
            return { ok: true, stale: false, data: await res.json() }
          } catch { return { ok: false, stale: true, data: null } }
        },
        collect: (itemId, folderIds, newFolder) => post('/collect', {
          item_id: itemId,
          folder_ids: Array.isArray(folderIds) ? folderIds : [],
          ...(typeof newFolder === 'string' && newFolder.trim() ? { new_folder: newFolder.trim() } : {})
        }),
        folderOp: (action, { id, name } = {}) => post('/folder', { action, ...(id != null ? { id } : {}), ...(name != null ? { name } : {}) }),
        /* 设置页（settings.section）的取数与动作：GET 走 plainGet（不碰共享快照），写走 post/put */
        preferenceGet: () => plainGet('/preference'),
        preferencePut: (section, value) => put('/preference', { section, value }),
        tuningReset: () => post('/tuning-reset', {}),
        credentialStatus: () => plainGet('/credential-status'),
        credentialPut: (which, content) => put('/credential', { which, content }),
        envCheck: () => plainGet('/env-check'),
        diagTail: (lines) => plainGet('/diagnostics-tail?lines=' + (Number.isInteger(lines) ? lines : 50)),
        exportMd: () => post('/export', {}),
        cleanup: (days) => post('/cleanup', { days }),
        wipe: (confirmText) => post('/wipe', { confirm: confirmText }),
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
     * 面板只读不改；坏 JSON 与缺字段一律显式说"没写下理由"——
     * 留空看起来像"这条没有理由"，那是两种不同的事实。
     */
    function reasonOf(item) {
      return matchInfo(item).text || '（无理由）'
    }

    /** 抽屉里要分开渲染的三样：那句话、命中了哪些词、属于哪个主题组。 */
    function matchInfo(item) {
      let m
      try { m = JSON.parse(item?.match_json ?? '{}') } catch { m = {} }
      if (!m || typeof m !== 'object' || Array.isArray(m)) m = {}
      return {
        text: typeof m.reason === 'string' ? m.reason : '',
        keywords: Array.isArray(m.hitKeywords) ? m.hitKeywords : [],
        groups: Array.isArray(m.groups) ? m.groups : []
      }
    }

    // ---- src/client/format.js ----
    /** 面板里共用的格式化。视图不各写一份，否则"同一件事两种写法"又会回来。 */

    /** 秒 → 1:02:03 / 18:22；0、负数、非数字一律空串（徽章上留空比显示"0:0"诚实）。 */
    function fmtDuration(sec) {
      const s = Number(sec)
      if (!Number.isFinite(s) || s <= 0) return ''
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const r = Math.floor(s % 60)
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
    }

    /** 时间戳 → 本地可读时间；坏值说"时间未知"而不是显示 Invalid Date。 */
    function fmtTime(ms) {
      const t = Number(ms)
      if (!Number.isFinite(t) || t <= 0) return '（时间未知）'
      try {
        return new Date(t).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return new Date(t).toISOString()
      }
    }

    /**
     * 「读回失败」的统一话术：请求发出去了（甚至 2xx 了），但该读回来的内容没在应答里。
     * 抽屉、收藏页、夹操作三处共用这一句骨架——话术只写一遍，就不会各处漂移成三种说法。
     * 诚实底线：必须明说"没读回来"，不许写成"没有夹""你还没收藏过"那种把失败说成空的谎。
     */
    const readbackMiss = (what) => `${what}没读回来`

    /** 收藏这套界面里最常见的一次读回失败：夹列表读不回来，于是整页的收藏关系都无从显示。 */
    const foldersUnreadNote = `读不到夹（${readbackMiss('夹列表')}）`

    /**
     * 判断的入口只有一句话：「今天」的待判提示与汇报空态共用这一句——
     * 两处各写一遍的话，迟早漂移成两种说法，用户就得猜哪个才是对的。
     */
    const judgeHint = '对会话说一句「把今天的候选判一下」'

    // ---- src/client/css.js ----
    /**
     * 面板样式。**这份 CSS 里一个颜色字面量都没有**：所有颜色都从宿主 token 取，
     * 换主题（catppuccin / mocha / mica）这里自动跟着变——是"融进主题"，不是"自带皮肤"。
     *
     * token 名不是猜的：每个都在本机 dsh-study-desk（已在 0.2.1-rc.2 跑通的插件）里出现过，
     * test/css.test.js 拿那份清单卡住，写错名字等于在宿主里裸奔。
     * 也不写 `var(--x, light-dark(…))` 那种内联兜底：兜底色会在这份文件里重新引入硬编码颜色，
     * 而脱离宿主的样子是预览器的事——tools/preview.mjs 自己声明一张替身 token 表并标明是替身。
     */
    const CSS = `
    .bl-root{display:flex;flex-direction:column;width:100%;min-width:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
    .bl-root *{box-sizing:border-box;font-weight:400}
    .bl-icon{font-size:13px;line-height:1}
    .bl-nav{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:thin}
    .bl-brand{font-size:13px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-primary)}
    .bl-navlist{display:flex;gap:2px;flex:1;min-width:0}
    .bl-navitem{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;padding:6px 10px;min-height:32px;border-radius:7px;cursor:pointer;white-space:nowrap}
    .bl-navitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
    .bl-navitem[aria-current="page"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}
    .bl-band{display:flex;flex-wrap:wrap;gap:10px;padding:6px 14px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
    .bl-body{padding:14px 16px 20px;min-width:0;flex:1;overflow-y:auto}
    .bl-empty,.bl-note,.bl-more,.bl-count,.bl-gaps,.bl-pending{font-size:12px;color:var(--dsw-alias-label-secondary)}
    .bl-summary{font-size:13px;color:var(--dsw-alias-label-primary)}
    .bl-issues{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
    .bl-pending{font-size:12px;color:var(--dsw-alias-label-secondary)}
    .bl-actions{display:flex;gap:8px;margin:10px 0 2px}
    .bl-actions button,.bl-detail{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
    .bl-actions button:hover,.bl-detail:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-actions button:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}
    .bl-today,.bl-video,.bl-article,.bl-digest{display:flex;flex-direction:column;gap:8px;min-width:0}
    .bl-rail{margin-top:18px;min-width:0}
    .bl-rail h3{font-size:13px;font-weight:500;margin:0 0 8px;color:var(--dsw-alias-label-primary)}
    .bl-toolbar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-bottom:12px}
    .bl-toolbar select,.bl-toolbar input{font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
    .bl-toolbar input{flex:1;min-width:130px}
    .bl-toolbar button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
    .bl-toolbar button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:12px;min-width:0}
    .bl-card,.bl-row{appearance:none;text-align:left;font-family:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-height:32px;min-width:0}
    .bl-card:hover,.bl-row:hover,.bl-row[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
    .bl-card:focus-visible,.bl-row:focus-visible,.bl-navitem:focus-visible,.bl-actions button:focus-visible,.bl-detail:focus-visible,.bl-dbtns button:focus-visible,.bl-dbar button:focus-visible,.bl-facets input:focus-visible,.bl-collect input:focus-visible,.bl-newfolder input:focus-visible,.bl-newfolder button:focus-visible,.bl-toolbar button:focus-visible,.bl-foldertab:focus-visible,.bl-confirm button:focus-visible,.bl-setsave:focus-visible,.bl-setflag input:focus-visible,.bl-srcrow-head button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .bl-card-title,.bl-row-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
    .bl-card-meta,.bl-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;flex-wrap:wrap}
    .bl-why,.bl-row-why{font-size:12px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:7px;margin-top:auto}
    .bl-tier{font-size:11px;color:var(--dsw-alias-label-primary)}
    .bl-play{font-size:11px;color:var(--dsw-alias-label-dimmed)}
    .bl-thumb{position:relative;aspect-ratio:16/9;border-radius:6px;background:var(--dsw-alias-bg-layer-3);display:block}
    .bl-dur{position:absolute;right:5px;bottom:5px;font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
    .bl-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:14px;align-items:start;min-width:0}
    .bl-list{display:flex;flex-direction:column;gap:8px;min-width:0}
    .bl-reader{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:13px 15px;min-height:200px;min-width:0;display:flex;flex-direction:column;gap:8px}
    .bl-reader h4{margin:0;font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary)}
    .bl-reader-by,.bl-reader-hint,.bl-reader-link{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
    .bl-reader-body{font-size:13px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
    .bl-library{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
    .bl-library-body{display:flex;flex-direction:column;gap:10px;min-width:0}
    .bl-facets{display:flex;flex-direction:column;gap:12px;font-size:12px;min-width:0}
    .bl-facet{display:flex;flex-direction:column;gap:2px;min-width:0}
    .bl-facets h4{margin:0 0 4px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
    .bl-facets label{display:flex;gap:6px;align-items:center;min-height:32px;font-size:12px;color:var(--dsw-alias-label-secondary)}
    .bl-collections{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
    .bl-folderlist{display:flex;flex-direction:column;gap:4px;min-width:0}
    .bl-foldertab{appearance:none;font-family:inherit;text-align:left;font-size:12px;min-height:32px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
    .bl-foldertab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
    .bl-foldertab[aria-current="page"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}
    .bl-collection-body{display:flex;flex-direction:column;gap:10px;min-width:0}
    .bl-in{font-size:11px;color:var(--dsw-alias-label-tertiary)}
    .bl-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-primary)}
    .bl-confirm p{margin:0;flex:1;min-width:180px}
    .bl-confirm button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
    .bl-confirm button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-empty-state{padding:18px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
    .bl-dsum{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px}
    .bl-dsum h3{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
    .bl-dhead{font-size:13px;color:var(--dsw-alias-label-primary);margin:0}
    .bl-dtiers{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
    .bl-drawer{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:flex;flex-direction:column;max-height:80vh;overflow:hidden}
    .bl-dbar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
    .bl-dtitle{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
    .bl-badge{font-size:11px;color:var(--dsw-alias-brand-primary);white-space:nowrap}
    .bl-dbar button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:4px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
    .bl-dbar button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-dmain{padding:12px 14px;display:flex;flex-direction:column;gap:11px;overflow-y:auto;font-size:12px;min-width:0}
    .bl-dmain section{display:flex;flex-direction:column;gap:4px}
    .bl-dmain h5{margin:0 0 3px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
    .bl-dmain p{margin:0;word-break:break-word;color:var(--dsw-alias-label-primary)}
    .bl-kv{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
    .bl-missing{color:var(--dsw-alias-state-error-primary)}
    .bl-collect{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:12px}
    .bl-collect label{display:flex;gap:6px;align-items:center;min-height:32px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
    .bl-collect label:hover{color:var(--dsw-alias-label-primary)}
    .bl-collect input{width:14px;height:14px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
    .bl-collect input:disabled{cursor:progress}
    .bl-newfolder{display:flex;gap:6px;align-items:center}
    .bl-newfolder input{flex:1;min-width:0;font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
    .bl-newfolder button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
    .bl-newfolder button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-newfolder button:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}
    .bl-kw{font-size:11px;color:var(--dsw-alias-label-secondary)}
    .bl-url{font-size:12px;color:var(--dsw-alias-brand-primary);word-break:break-all}
    .bl-feedback{margin:0;padding:7px 14px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
    .bl-dbtns{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
    .bl-dbtns button{flex:1;appearance:none;font-family:inherit;font-size:12px;min-height:32px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
    .bl-dbtns button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-dbtns .bl-save{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
    /* 设置页（settings.section，四页签）。tab 条复用收藏页的 folderlist/foldertab 那套 */
    .bl-settings{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
    .bl-settings-body{display:flex;flex-direction:column;gap:14px;min-width:0}
    .bl-setblock{display:flex;flex-direction:column;gap:8px;min-width:0}
    .bl-setblock h4{margin:6px 0 0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
    .bl-setfield{display:flex;flex-direction:column;gap:4px;min-width:0}
    .bl-setlabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
    .bl-sethint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
    .bl-setfield textarea,.bl-setfield input,.bl-setfield select,.bl-setrow input,.bl-setrow select{font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
    .bl-setfield textarea{resize:vertical;min-height:56px}
    .bl-setrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
    .bl-setrow input{width:120px;min-width:0}
    .bl-setrow input[type="text"]{flex:1;min-width:140px;width:auto}
    .bl-setsave{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;align-self:flex-start}
    .bl-setsave:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-setsave:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}
    .bl-setflag{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-height:32px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
    .bl-setflag:hover{color:var(--dsw-alias-label-primary)}
    .bl-setflag input{width:14px;height:14px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
    .bl-seterr{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
    .bl-seterr li{border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:7px}
    /* danger 不再只属于确认框：库页签的「清空库」按钮与说明行共用这枚红字 */
    .bl-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
    .bl-srcrow{display:flex;flex-direction:column;gap:5px;min-width:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
    .bl-srcrow-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
    .bl-srctoggle{display:flex;gap:7px;align-items:center;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}
    .bl-srctoggle input{width:14px;height:14px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
    .bl-srcrow-head button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
    .bl-srcrow-head button:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bl-srcform{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;align-items:center;margin-top:6px}
    .bl-srcform input,.bl-srcform select{font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:0;width:100%}
    .bl-diagtext{margin:0;padding:9px 10px;max-height:220px;overflow:auto;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-family:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary)}
    @media (max-width:820px){.bl-two,.bl-library,.bl-collections,.bl-settings{grid-template-columns:minmax(0,1fr)}}
    @media (prefers-reduced-motion:reduce){.bl-root *{transition:none;animation:none}}
    `

    let injected = false

    /** 只注入一次；宿主可能多次装载同一个客户端模块，重复注入会让样式表越堆越长。 */
    function injectStyles() {
      if (injected) return false
      if (typeof document === 'undefined' || !document.createElement) return false
      const el = document.createElement('style')
      el.setAttribute('data-baleen', '')
      el.textContent = CSS
      const parent = document.head || document.body
      if (!parent || typeof parent.appendChild !== 'function') return false
      parent.appendChild(el)
      injected = true
      return true
    }

    // ---- src/client/views/shell.js ----
    /**
     * 面板外壳：顶部导航（门户式六格）+ 全局异常带 + 渲染失败的降级块。
     *
     * 导航是"像网站那样"的主要载体，所以它和视图一样是可测的纯函数——
     * 预览器（tools/preview.mjs）渲染的就是这同一个 Nav，
     * 她看预览时看到的导航布局与真机一致，不是预览里另画一条。
     */

    /** id 与 view-state 的 VIEWS 一字不差；顺序就是点击顺序。 */
    const NAV_ITEMS = [['today', '今天'], ['video', '视频'], ['article', '文章'], ['collections', '收藏'], ['digest', '汇报'], ['library', '库']]

    function Nav({ view, pending = 0, onPick }) {
      return vnode('nav', { className: 'bl-nav', 'aria-label': '主导航' }, [
        vnode('span', { className: 'bl-brand' }, ['Baleen']),
        vnode('div', { className: 'bl-navlist' }, NAV_ITEMS.map(([id, label]) => vnode('button', {
          type: 'button',
          key: id,
          className: 'bl-navitem',
          'aria-current': view === id ? 'page' : 'false',
          onClick: () => onPick?.(id)
        }, [label + (id === 'today' && pending ? ` ·待判${pending}` : '')])))
      ])
    }

    /** 全局异常带：偏好文件坏了 / 接口没答上 / 手动那轮失败。没问题时这一格什么都不渲染。 */
    function TopBar({ stale, runError, preferenceErrors }) {
      const bits = []
      if (preferenceErrors && preferenceErrors.length) {
        bits.push(`偏好文件有 ${preferenceErrors.length} 处问题：${preferenceErrors.slice(0, 2).join('；')}`)
      }
      if (stale) bits.push('宿主接口没答上，下面是上次成功时的快照')
      if (runError) bits.push('这一轮没跑成：' + runError)
      if (!bits.length) return null
      return vnode('div', { className: 'bl-band', role: 'alert' }, bits)
    }

    function NotReady({ text }) {
      return vnode('div', { className: 'bl-empty' }, [text])
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
      // gaps 缺席（state 里没有这轮的记录）才说"还没有"；跑过轮但零丢弃零豁免时诚实显示"丢弃 0"——
      // M3 真机验收见过：定时空配置一轮抓 0 条，旧文案把"跑过但空"谎报成"还没有一轮记录"。
      if (gaps == null || typeof gaps !== 'object') return '（还没有一轮记录）'
      const by = gaps.by_reason ?? {}
      const kept = Object.entries(gaps.kept_with_flag ?? {})
      const held = n(gaps.held)
      // 收藏钉住（D15）：豁免的丢弃没发生，不进 by_reason，单独一枚 chip，大于零才显示。
      return [`丢弃 ${n(gaps.total_dropped)}`, ...Object.entries(by).map(([k, v]) => `${GAP_LABELS[k] ?? k} ${v}`),
        ...(kept.length ? [`保留待读：${kept.map(([k, v]) => `${FLAG_LABELS[k] ?? k} ${v}`).join(' / ')}`] : []),
        ...(held ? [`收藏钉住 ${held}`] : [])].join(' · ')
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
      return vnode('button', { type: 'button', className: 'bl-card', onClick: () => onOpen?.(item.id) }, [
        item.kind === 'video' ? vnode('span', { className: 'bl-thumb' }, [vnode('span', { className: 'bl-dur' }, [fmtDuration(item.duration_sec) || '—'])]) : null,
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
            ? `待判 ${pending} 条——判断由会话来做，${judgeHint}就行`
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
        // M4a 裁定：内嵌播放器 V5 才评估，哪个平台都还没法在抽屉里播——卡片统一只说跳转，
        // 不许再对 B 站单独许诺"可在抽屉内播"（抽屉的能力边界同一时刻在说反话）。
        vnode('span', { className: 'bl-play' }, ['只能跳转'])
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

    // ---- src/client/views/article.js ----
    /**
     * 「文章」视图：左列表右正文。这一屏要处理的核心事实是——**"只有摘要"是常态不是故障**：
     * 很多源本来就不吐全文，插件没坏。所以每种 body_state 都要有自己的说法，
     * 尤其不能把"源只给摘要"和"读不到内容"混成一句话（那是两种完全不同的责任）。
     */

    const STATE_HINT = {
      full: '',
      summary_only: '这个源只给摘要，全文在原文里',
      subtitle: '来自字幕',
      transcribed: '来自本地转写',
      missing: '读不到内容（没有语音，也没抓到正文）',
      burned_in: '硬字幕读不到（字烧在画面上，不是插件偷懒）'
    }
    const STATE_OPTIONS = [
      ['full', '全文'], ['summary_only', '仅摘要'], ['subtitle', '字幕'],
      ['transcribed', '转写'], ['missing', '读不到'], ['burned_in', '硬字幕']
    ]

    function visibleArticles(items, filters = {}) {
      const q = String(filters.q ?? '').trim().toLowerCase()
      return (items ?? []).filter((i) => i.kind === 'article' || i.kind === 'note')
        .filter((i) => !filters.source || i.source_id === filters.source)
        .filter((i) => !filters.state || i.body_state === filters.state)
        .filter((i) => !q || `${i.title ?? ''} ${i.body_text ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
    }

    /** 面板能读的那部分原文：抓到的是正文就读正文，只有摘要就读摘要，两个都没有就是空。 */
    function readableBody(item) {
      const t = item?.body_text ?? item?.summary_hint ?? ''
      return typeof t === 'string' ? t.trim() : ''
    }

    function ArticleView({ items = [], filters = {}, selectedId, onFilter, onSelect, onOpen }) {
      const list = visibleArticles(items, filters)
      const cur = list.find((i) => i.id === selectedId) ?? list[0] ?? null
      const body = cur ? readableBody(cur) : ''
      const sources = [...new Set(items.filter((i) => i.kind !== 'video').map((i) => i.source_id))]

      return vnode('div', { className: 'bl-article' }, [
        vnode('div', { className: 'bl-toolbar' }, [
          vnode('select', {
            'aria-label': '来源', value: filters.source ?? '',
            onChange: (e) => onFilter?.({ view: 'article', key: 'source', value: e?.target?.value ?? '' })
          }, [vnode('option', { value: '' }, ['来源：全部']), ...sources.map((s) => vnode('option', { key: s, value: s }, [s]))]),
          vnode('select', {
            'aria-label': '正文', value: filters.state ?? '',
            onChange: (e) => onFilter?.({ view: 'article', key: 'state', value: e?.target?.value ?? '' })
          }, [vnode('option', { value: '' }, ['正文：全部']), ...STATE_OPTIONS.map(([v, l]) => vnode('option', { key: v, value: v }, [l]))]),
          vnode('input', {
            type: 'search', 'aria-label': '关键词', placeholder: '在这批文章里找',
            value: filters.q ?? '',
            onChange: (e) => onFilter?.({ view: 'article', key: 'q', value: e?.target?.value ?? '' })
          })
        ]),
        vnode('div', { className: 'bl-two' }, [
          vnode('div', { className: 'bl-list', role: 'list' }, list.map((i) => vnode('button', {
            type: 'button', key: i.id, className: 'bl-row',
            'aria-selected': cur && cur.id === i.id ? 'true' : 'false',
            onClick: () => onSelect?.(i.id)
          }, [
            vnode('span', { className: 'bl-row-meta' }, [i.source_id, i.kind === 'note' ? '图文笔记' : '文章']),
            vnode('span', { className: 'bl-row-title' }, [i.title || '（无标题）']),
            vnode('span', { className: 'bl-row-why' }, [reasonOf(i)])
          ]))),
          vnode('article', { className: 'bl-reader', 'aria-live': 'polite' }, cur ? [
            vnode('h4', {}, [cur.title || '（无标题）']),
            vnode('p', { className: 'bl-reader-by' }, [
              `${cur.source_id} · ${cur.author || '未知作者'}`,
              Number(cur.time_estimated) > 0 ? `约 ${Math.round(Number(cur.time_estimated))} 分钟` : ''
            ]),
            STATE_HINT[cur.body_state] ? vnode('p', { className: 'bl-reader-hint' }, [STATE_HINT[cur.body_state]]) : null,
            vnode('div', { className: 'bl-reader-body' }, [body || '（没有正文，只能看原文）']),
            vnode('p', { className: 'bl-reader-link' }, ['读原文：' + (cur.url || '（这条没带链接）')]),
            vnode('button', { type: 'button', className: 'bl-detail', onClick: () => onOpen?.(cur.id) }, ['详情与反馈'])
          ].filter(Boolean) : [
            vnode('p', { className: 'bl-empty' }, ['左边没有条目。多半是这个筛选太窄，或者这一轮还没抓到东西。'])
          ])
        ])
      ])
    }

    // ---- src/client/views/digest.js ----
    /**
     * 「汇报」视图。M3 起这里展示判断轮真实落库的汇报（最近 5 条，倒序）；
     * 没有内容时唯一的责任仍是**把"为什么没有"说清楚**：
     * 是没跑过、还是接入了但还没判过、还是库里明明有汇报但面板没读到。
     * 三种情况写法不同，绝不拿假摘要填版面。
     */

    /**
     * @param state  宿主 /state 的返回（要 digest_count、counts.new、last_run）
     * @param loaded 面板手里真正拿到的汇报份数
     */
    function digestEmptyReason(state, loaded) {
      if (loaded > 0) return ''
      const total = Number(state?.digest_count) || 0
      if (total > 0) return `库里有 ${total} 份汇报，但面板没读到汇报内容——这一格现在数得出，读不出来。`
      if (!state || !state.last_run) return '还没跑过一轮：库是空的。去「今天」点"现在跑一轮"，或者等定时窗口自己起。'
      const pending = Number(state?.counts?.new) || 0
      return `判断轮已接入，但还没有跑过判断${pending ? `：库里待判 ${pending} 条` : ''}。${judgeHint}，判完这里就出汇报。`
    }

    /**
     * tiers 计数行：数字与 headline 同源（都出自 saveVerdicts 落的 stats）。
     * stats 缺了或没解出来就明说"没读出来"，不装作没有这一栏——那是把读回失败说成空。
     */
    function digestTierLine(stats) {
      const t = stats?.tiers
      if (!t) return '（这份汇报的计数没读出来）'
      return `值得看 ${Number(t['值得看']) || 0} · 可以看 ${Number(t['可以看']) || 0} · 不值当 ${Number(t['不值当']) || 0}`
    }

    function DigestView({ digests = [], state }) {
      const reason = digestEmptyReason(state, digests.length)
      if (reason) return vnode('div', { className: 'bl-digest bl-empty-state' }, [reason])
      const sorted = [...digests].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
      return vnode('div', { className: 'bl-digest' }, sorted.map((d) => vnode('section', { className: 'bl-dsum', key: d.id }, [
        vnode('h3', {}, [fmtTime(d.created_at)]),
        vnode('p', { className: 'bl-dhead' }, [d.headline || '（这份简报没写标题）']),
        vnode('p', { className: 'bl-dtiers' }, [digestTierLine(d.stats)])
      ])))
    }

    // ---- src/client/views/library.js ----
    /**
     * 「库」= 全量检索，含已归档。与另外三格不同，这里的筛选是多选（facet 勾选），
     * 因为查库的人通常在问"判过的里面哪些是不值当的"——单选取一个维度不够。
     * 组内 OR、组间 AND；一个组都没勾 = 不筛。
     */

    const FACETS = [
      { key: 'status', label: '状态', options: ['new', 'judged', 'digest', 'archived'] },
      { key: 'kind', label: '形态', options: ['article', 'video', 'note'] },
      { key: 'tier', label: '档位', options: ['值得看', '可以看', '不值当'] },
      { key: 'source', label: '来源', options: null }
    ]
    const PAGE = 100

    function libraryRows(items, filters = {}) {
      const allowed = (key, val) => {
        const sel = filters[key]
        return !Array.isArray(sel) || sel.length === 0 || sel.includes(val)
      }
      return (items ?? [])
        .filter((i) => allowed('status', i.status))
        .filter((i) => allowed('kind', i.kind))
        .filter((i) => allowed('tier', i.verdict_tier))
        .filter((i) => allowed('source', i.source_id))
        .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
    }

    function Facet({ def, options, filters, onFacet }) {
      const sel = Array.isArray(filters[def.key]) ? filters[def.key] : []
      return vnode('div', { className: 'bl-facet', 'data-facet': def.key, key: def.key }, [
        vnode('h4', {}, [def.label]),
        ...options.map((o) => vnode('label', { key: o }, [
          vnode('input', {
            type: 'checkbox',
            'aria-label': `${def.label}：${o}`,
            checked: sel.includes(o),
            onChange: (e) => onFacet?.({ view: 'library', key: def.key, value: o, on: Boolean(e?.target?.checked) })
          }),
          o
        ]))
      ])
    }

    function Row({ item, onOpen }) {
      const bits = [item.source_id, item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章', item.status]
      if (item.status === 'archived') bits.push(item.archived_reason ? `归档原因：${item.archived_reason}` : '归档原因没记')
      return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
        vnode('span', { className: 'bl-row-meta' }, bits),
        vnode('span', { className: 'bl-row-title' }, [item.title || '（无标题）']),
        item.verdict_tier ? vnode('span', { className: 'bl-tier' }, [`已判：${item.verdict_tier}`]) : null
      ].filter(Boolean))
    }

    function LibraryView({ items = [], filters = {}, onFacet, onOpen }) {
      const sources = [...new Set(items.map((i) => i.source_id))]
      const rows = libraryRows(items, filters)
      const shown = rows.slice(0, PAGE)

      return vnode('div', { className: 'bl-library' }, [
        vnode('aside', { className: 'bl-facets' }, FACETS.map((def) => Facet({ def, options: def.options || sources, filters, onFacet }))),
        vnode('div', { className: 'bl-library-body' }, [
          vnode('div', { className: 'bl-count' }, [`${rows.length} 条`]),
          rows.length
            ? vnode('div', { className: 'bl-grid' }, shown.map((i) => Row({ item: i, onOpen })))
            : vnode('p', { className: 'bl-empty' }, [items.length
              ? '这些勾选下没有条目。库里是有东西的——把勾选清一下。'
              : '库里还没有条目。先去「今天」跑一轮。']),
          rows.length > PAGE ? vnode('p', { className: 'bl-more' }, [`还有 ${rows.length - PAGE} 条，翻分页看（这一屏只放 ${PAGE} 条）`]) : null,
          vnode('p', { className: 'bl-note' }, ['改判由会话通过 baleen.save_verdicts 做，这里不放改判按钮；批量归档（M3）尚未接入。'])
        ].filter(Boolean))
      ])
    }

    // ---- src/client/views/drawer.js ----
    /**
     * 条目抽屉：这条"为什么给你"的落点，也是唯一会改偏好的交互面。
     *
     * 两个按钮的语义必须写在界面上：**只动来源权重（tuning），不动主题词（themes）**。
     * 结果一定要回显——点了不知道有没有记上，等于把偏好系统的黑盒交给了用户。
     */

    const DELTA = { dismiss: '-0.1', save: '+0.1' }
    /** 每种 body_state 一句说法：正文区与能力边界共用，别两处各写一遍再各自漂移 */
    const STATE_NOTE = {
      full: '',
      summary_only: '只有摘要：这个源只给摘要，全文在原文里——不是我们读不到。',
      subtitle: '字幕全文已存，正文区就是字幕。',
      transcribed: '这段来自本地转写。',
      missing: '没有语音也没有字幕轨，读不到内容。',
      burned_in: '硬字幕：字烧在画面上，读不到内容。'
    }
    /** 这三种是"能力边界"，其余只是内容来源说明 */
    const LIMITS = new Set(['summary_only', 'missing', 'burned_in'])

    function feedbackHint(action) {
      return action === 'dismiss'
        ? '不感兴趣：只改来源权重（-0.1，累计限幅 ±0.5），不改你的主题词'
        : '这源多来点：只改来源权重（+0.1，累计限幅 ±0.5），不改你的主题词'
    }

    /**
     * 能不能播（按源）与能不能读（按 body_state）是两件事，各自说一句。
     * 早先只回一句的话，B 站硬字幕条目会被播放器的说法盖掉，看不出内容其实读不到。
     * 播放器 M4a 没做（V5 先探后定），所以这里不许预告任何接入时间——跳转就是现状。
     */
    function boundaryNote(item) {
      const bits = []
      if (item?.kind === 'video') {
        bits.push(item.source_id === 'bili'
          ? 'B 站：抽屉内嵌播放器还没定下来，现在跳到浏览器里看。'
          : '这个平台没有可靠的嵌入方案，只能跳到浏览器里看。')
      }
      if (LIMITS.has(item?.body_state)) bits.push(STATE_NOTE[item.body_state])
      return bits.join(' ')
    }

    const kindLabel = (kind) => (kind === 'video' ? '视频' : kind === 'note' ? '图文笔记' : '文章')

    function Section({ title, children }) {
      return vnode('section', {}, [vnode('h5', {}, [title]), ...children.filter(Boolean)])
    }

    /**
     * 勾上/取消某个夹之后该提交的集合。规矩是"原有在前、新勾追加"：
     * 不按夹列表的顺序反推——那个顺序是面板右侧的展示顺序，不是这条的归属历史；
     * 条目上已有的、夹列表里认不出的 id 一律原样留着——那多半是"这一秒刚被另一格删掉"，
     * 静默丢弃等于替用户做了他没做的决定。
     * folders 参数暂不参与排序，留着是为了签名与夹列表同源（调用方不必自己先换算）。
     */
    function collectSetOf(item, folders, toggleId, on) {
      const cur = Array.isArray(item?.folders) ? item.folders.filter((x) => Number.isInteger(x)) : []
      void folders
      return on ? [...new Set([...cur, toggleId])] : cur.filter((x) => x !== toggleId)
    }

    /**
     * 装配层的"过期归属"覆盖：抽屉里那条来自不带 folders 字段的查询时（今天的三格），
     * /collect 成功读回的归属按条目 id 覆盖回抽屉这一条——只改抽屉的展示，不动列表真相。
     * 没有这层，连点两个勾各自从"没读到"算起，第二次全量替换会把第一次的放进整个抹掉。
     * 只在 found 存在、自身没有 folders、knownFolders 指的是同一条时才覆盖，其余原样返回。
     */
    function drawerItemWithFolders(found, knownFolders) {
      return found && !Array.isArray(found.folders) && knownFolders && knownFolders.itemId === found.id
        ? { ...found, folders: knownFolders.folder_ids }
        : found
    }

    /** 夹 id 说回人能认的名字；列表里查不到就明写"这个夹已经没了"，不编一个 */
    const namesOf = (item, folders, ids) => (ids ?? []).map((id) =>
      (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`).join(' / ') || '（现在不在任何夹里）'

    function Drawer({ item, api = {}, onClose, onDone, note, folders = [], collecting = false, newFolderName = '', onNewFolderName = () => {} }) {
      async function fire(action) {
        let res = null
        try {
          res = await api.feedback?.(item?.source_id, action)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        const message = res && res.ok
          ? `${item.source_id} 权重 ${DELTA[action]}——只改 tuning，你的 themes 一个字没动`
          : `没记上（${(res && res.error) || '宿主接口没应答'}）`
        onDone?.({ message, action })
        return message
      }

      async function toggleCollect(folderId, on) {
        return submit(collectSetOf(item, folders, folderId, on))
      }

      /**
       * 收藏的提交：/collect 是全量替换，回显必须来自服务端读回（或明说读不到）。
       * 三分支都要走到话：成功、folder_gone（带是哪几个）、其它失败——点了没反应
       * 等于把偏好系统的黑盒交给用户。res 形状不保证带 stale，一律按 ok/error 分支。
       */
      async function submit(folderIds, newFolder) {
        let res = null
        try {
          res = await api.collect?.(item?.id, folderIds, newFolder)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        // data 可能是 null（2xx 但 body 没读出来）：名字与归属都用"能读回什么"分支，读不到就回退到发出去的意图。
        const readFolders = res && res.ok && Array.isArray(res.data?.folders) ? res.data.folders : null
        const readIds = res && res.ok && Array.isArray(res.data?.folder_ids) ? res.data.folder_ids : null
        const known = readFolders ?? folders
        const after = res && res.ok ? (readIds ?? folderIds) : null
        // 应答里既没带归属也没带夹表时不许光说"已放进"：那是没读回来，不是读到了（话术与收藏页同一句）。
        const unreadTail = after && readIds === null && readFolders === null ? `（${readbackMiss('服务端确认的归属')}，这句是按你勾的说的）` : ''
        const message = after
          ? `已放进：${namesOf(item, known, after)}${unreadTail}`
          : res && res.error === 'folder_gone'
            ? `没记上：${res.missing?.length ? `夹 ${res.missing.join('、')} 已经不在了` : `有夹已经不在了，但${readbackMiss('是哪几个')}`}，重新勾一次`
            : res && res.error === 'name_taken'
              // 新建重名夹是用户真会踩到的失败（终审 D1）：说人话，别把英文短码直出给用户。
              // 与收藏页 runFolder 的映射逐字一致；bad_name/name_too_long 在抽屉不可达
              // （空串不发请求、maxLength=40 挡输入），不用映射。
              ? '已经有这个夹了'
              : `没记上（${(res && res.error) || '宿主接口没应答'}）`
        onDone?.({ message, kind: 'collect', folderIds: after ?? undefined, folders: readFolders ?? undefined })
        return message
      }

      if (!item) {
        return vnode('aside', { className: 'bl-drawer bl-empty-state', role: 'dialog', 'aria-label': '条目详情' }, [
          vnode('p', {}, ['这条不在当前列表里（可能已被新的一对替换，或在归档的那批里）。关掉这格，去「库」里按状态找。']),
          vnode('button', { type: 'button', onClick: () => onClose?.() }, ['关闭'])
        ])
      }

      const m = matchInfo(item)
      const body = typeof item.body_text === 'string' ? item.body_text.trim() : ''
      const hasFolders = (folders ?? []).length > 0

      return vnode('aside', { className: 'bl-drawer', role: 'dialog', 'aria-label': '条目详情' }, [
        vnode('header', { className: 'bl-dbar' }, [
          vnode('span', { className: 'bl-badge' }, [item.source_id || '（没来源）']),
          vnode('span', { className: 'bl-dtitle' }, [item.title || '（无标题）']),
          vnode('button', { type: 'button', onClick: () => onClose?.() }, ['关闭'])
        ]),
        vnode('div', { className: 'bl-dmain' }, [
          vnode('div', { className: 'bl-kv' }, [
            item.author || '未知作者',
            kindLabel(item.kind),
            item.verdict_tier ? `已判：${item.verdict_tier}` : '待判',
            // 时长只对视频有意义，且坏值（0/非数字）不给徽章留个"时长"空壳——fmtDuration 返回空串就整段不画
            item.kind === 'video' && fmtDuration(item.duration_sec) ? `时长 ${fmtDuration(item.duration_sec)}` : null
          ].filter(Boolean)),
          Section({
            title: '为什么给你',
            children: [
              vnode('p', { className: m.text ? '' : 'bl-missing' }, [m.text || '（这条没写理由）']),
              m.keywords.length
                ? vnode('p', { className: 'bl-kw' }, ['命中词：' + m.keywords.join('、') + (m.groups.length ? `（${m.groups.join('、')}）` : '')])
                : null
            ]
          }),
          Section({
            title: item.kind === 'video' ? '字幕原文' : '正文',
            children: [
              vnode('p', {}, [body || '（没有可读内容）']),
              STATE_NOTE[item.body_state] ? vnode('p', { className: 'bl-reader-hint' }, [STATE_NOTE[item.body_state]]) : null
            ]
          }),
          item.verdict_why ? Section({ title: '会话的判断', children: [vnode('p', {}, [`为什么判成「${item.verdict_tier}」：${item.verdict_why}`])] }) : null,
          boundaryNote(item) ? Section({ title: '能力边界', children: [vnode('p', {}, [boundaryNote(item)])] }) : null,
          Section({
            title: '收藏到…',
            children: [
              hasFolders ? null : vnode('p', { className: 'bl-missing' }, [`${foldersUnreadNote}，这次没法收藏。`]),
              // 这条 item 可能来自不带 folders 字段的查询（今天的三格）：那是"没读到"，不是"在 0 个夹里"，
              // 明说全量替换的后果，让用户知道自己勾的会被当成全部归属。
              Array.isArray(item.folders) ? null : vnode('p', { className: 'bl-note' }, ['这条当前在哪些夹里还没读到；下面以空勾起步，放进会把你勾的当成它的全部归属。']),
              hasFolders ? vnode('div', { className: 'bl-collect' }, folders.flatMap((f) => [
                vnode('input', {
                  key: `cb-${f.id}`,
                  type: 'checkbox',
                  id: `baleen-cb-${item.id}-${f.id}`,
                  'aria-label': '放进：' + f.name,
                  checked: (item.folders ?? []).includes(f.id),
                  disabled: Boolean(collecting),
                  onChange: (e) => toggleCollect(f.id, Boolean(e?.target?.checked))
                }),
                vnode('label', { key: `lb-${f.id}`, htmlFor: `baleen-cb-${item.id}-${f.id}` }, [f.name + (f.is_default ? '（默认）' : '')])
              ])) : null,
              vnode('div', { className: 'bl-newfolder' }, [
                vnode('input', { type: 'text', 'aria-label': '新夹名', placeholder: '起个名，1-40 字', maxLength: 40, value: newFolderName, onChange: (e) => onNewFolderName?.(e?.target?.value ?? '') }),
                vnode('button', {
                  type: 'button',
                  disabled: Boolean(collecting),
                  onClick: () => ((newFolderName ?? '').trim()
                    ? submit([...(item.folders ?? [])], (newFolderName || '').trim())
                    : undefined)
                }, ['新建夹并放入'])
              ])
            ]
          }),
          item.url ? Section({ title: '链接', children: [vnode('p', { className: 'bl-url' }, [item.url])] }) : null,
          vnode('p', { className: 'bl-note' }, ['下面两个按钮只调来源权重，不改你的主题词；当前偏移在设置页（M5）能看到也能一键归零。'])
        ]),
        note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
        vnode('footer', { className: 'bl-dbtns' }, [
          vnode('button', { type: 'button', title: feedbackHint('dismiss'), onClick: () => fire('dismiss') }, ['不感兴趣']),
          vnode('button', { type: 'button', className: 'bl-save', title: feedbackHint('save'), onClick: () => fire('save') }, ['这源多来点'])
        ])
      ])
    }

    // ---- src/client/views/collections.js ----
    /**
     * 「收藏」页：左列是夹，右区是这个夹里收过的条目。
     *
     * 三条诚实规矩：
     *  1. 已归档的条目照样列出并写明原因——"我收过的东西不会凭空消失"（spec D15）；
     *  2. 夹上的数字与点进去的条数同源（都来自 folder_items 的 COUNT，不筛状态），
     *     所以这里绝不再按 status 滤一遍，否则"写着 3 条点进去 2 条"；
     *  3. 一个夹都没读回来时不许假装：不画标签栏、不画卡片，也不说"你一条都还没收过"
     *     ——把读回失败说成"空的"是谎（话术与抽屉共用 format.js 里那一句）。
     *
     * 纯函数：不发请求、不读 window，产 {type, props, children}，由装配层经 toElement 桥给 React。
     */

    /** 只给顺序，不改数据：默认夹永远第一，其余按 id（与服务端 listFolders 的次序同源）。 */
    const folderTabs = (folders) => (folders ?? []).slice()
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id - b.id)

    /** 夹 id 说回人能认的名字；列表里查不到就明写"这个夹已经没了"，不编一个名字。 */
    const nameOf = (folders, id) =>
      (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`

    /**
     * 这一屏看的是哪个夹：筛选里那个夹**在读回的列表里认得出**才算，否则落到默认夹（folderTabs 的第一个）。
     * "认不出就回落"不是敷衍：筛选里的 id 很可能是另一格刚删掉的夹，把已消失的夹当成当前夹会继续
     * 拿它去取数（恒空），页面就成了"这个夹还是空的"那种谎。
     * 一个夹都没读回来时返回 null —— 装配层据此连 folder 参数都不发，
     * 免得把"没筛夹"捞回来的一堆条目当成收藏关系画出来。
     */
    const currentFolderId = (folders, filters) => {
      const list = folders ?? []
      const wanted = Number(filters?.folder)
      if (wanted && list.some((f) => f.id === wanted)) return wanted
      return folderTabs(list)[0]?.id ?? null
    }

    function CollectedCard({ item, folders, cur, onOpen }) {
      // spec §6.2 卡面要的是"它还在哪些**别的**夹里"：item.folders 里含当前夹自己，
      // 不滤掉就会在单夹条目上写出"还在：默认"这种语病。滤完一个不剩时这行整个不出现——
      // 原文没规定空列表的说法，最不撒谎的做法是什么都不说。
      const alsoIn = (item.folders ?? []).filter((id) => id !== cur)
      return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
        vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
        vnode('span', { className: 'bl-card-meta' }, [
          item.source_id || '（没来源）',
          item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章',
          // 收进来的时间，不是发布时间：这页回答的是"我什么时候存的"
          '收进来：' + fmtTime(item.added_at)
        ]),
        item.status === 'archived'
          ? vnode('span', { className: 'bl-missing' }, [`已归档：${item.archived_reason || '原因没记'}（收藏不会让它重新出现在今天）`])
          : null,
        alsoIn.length
          ? vnode('span', { className: 'bl-in' }, ['还在：' + alsoIn.map((id) => nameOf(folders, id)).join(' / ')])
          : null
      ].filter(Boolean))
    }

    function CollectionsView({
      items = [], folders = [], filters = {}, pendingDelete = null, note,
      newFolderName = '', currentName = null, folderBusy = false,
      onNewFolderNameChange = () => {}, onCurrentNameChange = () => {},
      onPickFolder, onCreate, onRename, onAskDelete, onCancelDelete, onDelete, onOpen
    }) {
      const list = folders ?? []
      const tabs = folderTabs(list)
      const cur = currentFolderId(list, filters)
      // 当前夹就是 currentFolderId 认下来的那一个：与装配层取数用的是同一个 id，页面不会自相矛盾。
      const curFolder = list.find((y) => y.id === cur) ?? null
      const total = list.reduce((sum, f) => sum + (Number(f.count) || 0), 0)
      const unread = !list.length
      // 二次确认只跟着"当前正在看的那个夹"：pendingDelete 指向别的夹时不该拦住这一夹的工具条
      const confirming = pendingDelete != null && curFolder != null && pendingDelete === curFolder.id
      // 改名框：装配层的草稿优先（null 才是"没草稿"，回落到服务端读到的夹名，不是空框让人猜）。
      // 空串是"用户清空了草稿"，得保持空——用 || 会把清空误当没草稿，一松手就被旧名填回（终审 #15）。
      const renameValue = currentName ?? curFolder?.name ?? ''
      // 建夹/改名/删除的在途标记（终审 #18，照抄抽屉 collecting 的规矩）：忙时按钮禁用、
      // 改名框不提交——双击建夹第二次会拿到 name_taken，回显对着刚建好的夹说"已经有这个夹了"。
      const busy = Boolean(folderBusy)

      const emptyText = unread
        ? `${foldersUnreadNote}。这一页列不出收藏关系，但你收过的条目一条都没少——回到「今天」再点一次收藏，或者刷新这格。`
        : total === 0
          ? '你一条都还没收过。在「今天」或「视频」里点开一条，抽屉下方有「收藏到…」。'
          : `这个夹还是空的（「${curFolder?.name ?? '当前夹'}」里一条都没有）。去别的页用抽屉「收藏到…」放进来。`

      return vnode('div', { className: 'bl-collections' }, [
        unread ? null : vnode('aside', { className: 'bl-folderlist', 'aria-label': '收藏夹' },
          tabs.map((f) => vnode('button', {
            type: 'button', key: f.id, className: 'bl-foldertab', 'data-folder': f.id,
            'aria-current': f.id === cur ? 'page' : 'false',
            onClick: () => onPickFolder?.(f.id)
          }, [`${f.name}${f.is_default ? '（默认）' : ''} ${Number(f.count) || 0} 条`]))),
        vnode('div', { className: 'bl-collection-body' }, [
          confirming
            ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认删除夹' }, [
              vnode('p', {}, [`确认删除「${curFolder.name}」？只删收藏关系，条目本身不动——里面 ${Number(curFolder.count) || 0} 条还会在「库」里看得到。`]),
              vnode('button', { type: 'button', onClick: () => onCancelDelete?.() }, ['取消']),
              vnode('button', { type: 'button', className: 'bl-danger', disabled: busy, onClick: () => onDelete?.(curFolder.id) }, ['确认删除'])
            ])
            : vnode('div', { className: 'bl-toolbar' }, [
              vnode('input', {
                type: 'text', 'aria-label': '新建夹名', placeholder: '新建收藏夹（1-40 字）', maxLength: 40,
                value: newFolderName, onChange: (e) => onNewFolderNameChange?.(e?.target?.value ?? '')
              }),
              vnode('button', { type: 'button', disabled: busy, onClick: () => onCreate?.(newFolderName) }, ['建夹']),
              // 读不到夹表时（unread）只留「建夹」自救——建夹不依赖夹表，是读回失败时唯一的出路；
              // 改名与删除控件对着不存在的"当前夹"，点了只会得到对不存在场景编造的竞态解释（终审 #16）。
              unread ? null : vnode('input', {
                type: 'text', 'aria-label': '当前夹名', value: renameValue,
                onChange: (e) => onCurrentNameChange?.(e?.target?.value ?? ''),
                // 忙时挡提交不禁输入：请求在途还能继续打字改草稿，只是不许再叠一个请求
                onKeyDown: (e) => { if (e?.key === 'Enter' && !busy) onRename?.(cur, e?.target?.value ?? renameValue) }
              }),
              unread ? null : vnode('button', { type: 'button', disabled: busy, onClick: () => onRename?.(cur, renameValue) }, ['改名']),
              unread ? null : curFolder && !curFolder.is_default
                ? vnode('button', { type: 'button', disabled: busy, onClick: () => onAskDelete?.(cur) }, ['删除这个夹'])
                : null
            ].filter(Boolean)),
          note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
          // 读不到夹的时候 items 是"没筛夹"捞回来的全量，跟收藏关系无关，一张卡都不许画
          !unread && items.length
            ? vnode('div', { className: 'bl-grid' }, items.map((i) => CollectedCard({ item: i, folders: list, cur, onOpen })))
            : vnode('p', { className: 'bl-empty' }, [emptyText])
        ])
      ])
    }

    // ---- src/client/views/settings.js ----
    /**
     * 设置页（settings.section 槽）的四页签视图：源 / 偏好 / 凭据与环境 / 库。
     *
     * 与别的视图同一套规矩：纯函数，不发请求、不读 window，产 {type, props, children}；
     * 取数与草稿态全部由装配层（_footer.txt 的 SettingsView）持有并经 props 传进来。
     *
     * 三条本页特有的诚实底线：
     *  1. 偏好没读到（readOnly）时不画开关不放保存——盲 PUT sources 会把现有源整个抹掉；
     *  2. themes 的行格式只存得下 {group, any}：带必含/排除/权重的组不进文本、保存时原样并回
     *     （splitThemes），开了下设置页不等于把手编的高级条件悄悄抹掉；
     *  3. 坏行（theme/时间窗/数字/形态）当场标红并禁用保存——门在客户端，坏值根本轮不到发 PUT。
     */

    const SETTINGS_TABS = [['sources', '源'], ['pref', '偏好'], ['creds', '凭据与环境'], ['library', '库']]

    /** 与宿主 lib/preference.js 的 WINDOW_RE 同一条：两边漂移就会"这边说好那边 400"。 */
    const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
    const KINDS = ['video', 'article', 'note']
    const SOURCE_TYPES = ['rss', 'bili', 'yt']
    const EMPTY_SRC_DRAFT = () => ({ id: '', type: 'rss', url: '', label: '', interval_min: '', weight: '' })

    /* ---------------- 纯函数（导出给测试与装配层） ---------------- */

    /** `组名: 词1,词2` 每行一组（全角冒号也认）。坏行不抛：带行号进 errors，让页签当场标红并禁保存。 */
    function parseThemes(text) {
      const errors = []
      const themes = []
      String(text ?? '').split(/\r?\n/).forEach((line, i) => {
        const raw = line.trim()
        if (!raw) return
        const m = /^([^:：]{1,60})[:：]\s*(.*)$/.exec(raw)
        if (!m) { errors.push({ line: i + 1, text: raw, reason: '组名后面要跟半角或全角冒号' }); return }
        const group = m[1].trim()
        if (!group) { errors.push({ line: i + 1, text: raw, reason: '组名不能为空' }); return }
        const any = m[2].split(/[,，、]/).map((w) => w.trim()).filter(Boolean)
        if (!any.length) { errors.push({ line: i + 1, text: raw, reason: '至少一个主题词' }); return }
        themes.push({ group, any })
      })
      return { themes, errors }
    }

    const serializeThemes = (themes) =>
      (themes ?? []).map((t) => `${t.group}: ${(t.any ?? []).join(',')}`).join('\n')

    /**
     * 高级字段（must/never/weight≠1）在行格式里存不下：这批组不进文本编辑器，
     * 保存时原封不动并回去。宁可少给一个输入框，不悄悄丢用户手编的匹配条件。
     */
    function splitThemes(themes) {
      const simple = []
      const advanced = []
      for (const t of themes ?? []) {
        const isAdv = (t.must ?? []).length > 0 || (t.never ?? []).length > 0 || (t.weight != null && t.weight !== 1)
        ;(isAdv ? advanced : simple).push(t)
      }
      return { simple, advanced }
    }

    /** 逗号（中英文与顿号）与换行都算分隔的清单解析：排除词、跳过形态共用。 */
    const splitList = (text) =>
      String(text ?? '').split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean)

    /** 源的"最近抓取"一句：/state 的 sources 里认得到的才说结果，认不到就说还没抓过。 */
    function lastFetchNote(stateSources, id) {
      const s = (stateSources ?? []).find((x) => x.id === id)
      if (!s) return '还没抓过（保存后下一轮才碰它）'
      if (s.ok) return '最近抓取：正常'
      if (s.error_class === 'needs_login') return '最近抓取：需要重新登录（去「凭据与环境」贴 cookie）'
      return `最近抓取：失败（${s.error_class ?? '未知'}），游标没推进，下轮自动补`
    }

    function fmtBytes(n) {
      if (n == null) return '读不到'
      const v = Number(n)
      if (!Number.isFinite(v) || v < 0) return '读不到'
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(1)} MB`
    }

    const fmtDelta = (v) => (Number(v) > 0 ? `+${v}` : `${v}`)

    /* ---------------- 小控件 ---------------- */

    function Field({ label, hint, children }) {
      return vnode('div', { className: 'bl-setfield' }, [
        vnode('span', { className: 'bl-setlabel' }, [label]),
        ...children,
        hint ? vnode('span', { className: 'bl-sethint' }, [hint]) : null
      ].filter(Boolean))
    }

    const ERR = (lines) => lines.length
      ? vnode('ul', { className: 'bl-seterr' }, lines.map((e, i) => vnode('li', { key: i }, [e])))
      : null

    function SaveBtn({ text, disabled, onClick }) {
      return vnode('button', { type: 'button', className: 'bl-setsave', disabled: disabled || undefined, onClick }, [text])
    }

    /* ---------------- 页签一：源 ---------------- */

    function SourceRow({ s, status, confirming, busy, readOnly, onToggle, onAskDelete, onCancelDelete, onDelete }) {
      const name = `${s.id}（${s.type}${s.label ? ' · ' + s.label : ''}）`
      return vnode('div', { className: 'bl-srcrow', 'data-source': s.id, key: s.id }, [
        vnode('div', { className: 'bl-srcrow-head' }, [
          vnode('label', { className: 'bl-srctoggle' }, [
            vnode('input', {
              type: 'checkbox', 'aria-label': `启用 ${s.id}`,
              checked: s.enabled !== false, disabled: readOnly || busy || undefined,
              onChange: (e) => onToggle?.(s.id, Boolean(e?.target?.checked))
            }),
            name
          ]),
          confirming ? null : vnode('button', {
            type: 'button', disabled: readOnly || busy || undefined, onClick: () => onAskDelete?.(s.id)
          }, ['删除'])
        ].filter(Boolean)),
        vnode('div', { className: 'bl-card-meta' }, [
          `每 ${s.interval_min ?? 720} 分钟`,
          `权重 ${s.weight ?? 1}`,
          s.enabled === false ? '已停用' : '启用中'
        ]),
        vnode('div', { className: 'bl-kv' }, [status]),
        confirming
          ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': `确认删除源 ${s.id}` }, [
            vnode('p', {}, [`确认删除源 ${s.id}？只删配置（不再抓新的），已抓的条目不动、游标也保留。`]),
            vnode('button', { type: 'button', onClick: () => onCancelDelete?.() }, ['取消']),
            vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onDelete?.(s.id) }, ['确认删除'])
          ])
          : null
      ].filter(Boolean))
    }

    function SourcesTab({ loaded, sources, pref, hostState, srcDraft = EMPTY_SRC_DRAFT(), onSrcDraft,
      askDelete = null, onAskDelete, onCancelDelete, onToggleSource, onAddSource, onDeleteSource, readOnly = false, busy = false }) {
      // sources 显式传入优先（装配层给的），纯函数调用时从 pref 里取——同一份形状，两个入口
      const list = Array.isArray(sources) ? sources : (Array.isArray(pref?.sources) ? pref.sources : [])
      const draftOk = String(srcDraft.id ?? '').trim() && String(srcDraft.url ?? '').trim()
      return vnode('div', { className: 'bl-setblock' }, [
        vnode('h4', {}, ['源（preference.yaml 的 sources 节，每次保存都是全量替换）']),
        ...list.map((s) => SourceRow({
          s,
          status: lastFetchNote(hostState?.sources, s.id),
          confirming: askDelete === s.id,
          busy, readOnly,
          onToggle: onToggleSource, onAskDelete, onCancelDelete, onDelete: onDeleteSource
        })),
        list.length ? null : vnode('p', { className: 'bl-empty' }, [
          loaded
            ? '一个源都还没配。用下面的表单加第一个（保存后下一轮抓取才碰它）。'
            : '源列表还没读到（宿主接口没应上）——读不到时不画开关也不许编辑，防半盲写把现有源抹掉。'
        ]),
        vnode('div', { className: 'bl-srcform' }, [
          vnode('input', { type: 'text', 'aria-label': '源 id', placeholder: '如 demo-weekly', value: srcDraft.id,
            disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ id: e?.target?.value ?? '' }) }),
          vnode('select', { 'aria-label': '源类型', value: srcDraft.type,
            onChange: (e) => onSrcDraft?.({ type: e?.target?.value ?? 'rss' }) },
            SOURCE_TYPES.map((t) => vnode('option', { key: t, value: t }, [t]))),
          vnode('input', { type: 'text', 'aria-label': '源 URL', placeholder: 'http(s) 地址 / UP 主 space 页', value: srcDraft.url,
            disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ url: e?.target?.value ?? '' }) }),
          vnode('input', { type: 'text', 'aria-label': '源标签（可选）', placeholder: '标签（可选）', value: srcDraft.label,
            disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ label: e?.target?.value ?? '' }) }),
          vnode('input', { type: 'number', 'aria-label': '抓取间隔（分钟，可选）', placeholder: '间隔分钟', value: srcDraft.interval_min,
            disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ interval_min: e?.target?.value ?? '' }) }),
          vnode('input', { type: 'number', 'aria-label': '源权重（可选）', placeholder: '权重 0–2', value: srcDraft.weight,
            disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ weight: e?.target?.value ?? '' }) }),
          SaveBtn({ text: '新增源', disabled: readOnly || busy || !draftOk, onClick: () => onAddSource?.(srcDraft) })
        ])
      ].filter(Boolean))
    }

    /* ---------------- 页签二：偏好 ---------------- */

    function PrefsTab({ pref, themesDraft, onThemesDraft, redlinesDraft, onRedlinesDraft,
      scheduleDraft, onScheduleDraft, limitsDraft, onLimitsDraft, charterDraft, onCharterDraft,
      onSave, askResetTuning = false, onAskResetTuning, onCancelResetTuning, onResetTuning, readOnly = false, busy = false }) {
      // themes：行格式存得下的才进文本，高级组并回不丢
      const split = splitThemes(pref?.themes ?? [])
      const themesValue = themesDraft ?? serializeThemes(split.simple)
      const parsed = parseThemes(themesValue)
      const themesBad = parsed.errors.length > 0

      const redlinesValue = redlinesDraft ?? (pref?.redlines ?? []).join('\n')
      const sched = scheduleDraft ?? {
        windows: (pref?.schedule?.windows ?? []).join('\n'),
        max_per_run: String(pref?.schedule?.max_per_run ?? ''),
        max_per_day: String(pref?.schedule?.max_per_day ?? ''),
        off_peak_only: pref?.schedule?.off_peak_only !== false
      }
      const winLines = String(sched.windows ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const winErrs = winLines.filter((w) => !WINDOW_RE.test(w))
      const intOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
      const runN = intOf(sched.max_per_run)
      const dayN = intOf(sched.max_per_day)
      const schedBad = winErrs.length > 0 || runN == null || dayN == null || String(sched.max_per_run).trim() === '' || String(sched.max_per_day).trim() === ''
      const schedErrs = [
        ...winErrs.map((w) => `时间窗要写成 "07:00-09:00"：${w}`),
        ...(runN == null ? ['每轮上限要是正整数'] : []),
        ...(dayN == null ? ['每日上限要是正整数'] : [])
      ]

      const lim = limitsDraft ?? {
        max_age_days: String(pref?.limits?.max_age_days ?? ''),
        min_duration_sec: String(pref?.limits?.min_duration_sec ?? ''),
        skip_kinds: (pref?.limits?.skip_kinds ?? []).join(',')
      }
      const nnOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && String(v).trim() !== '' ? n : null }
      const ageN = nnOf(lim.max_age_days)
      const durN = nnOf(lim.min_duration_sec)
      const kinds = splitList(lim.skip_kinds)
      const badKinds = kinds.filter((k) => !KINDS.includes(k))
      const limBad = ageN == null || durN == null || badKinds.length > 0
      const limErrs = [
        ...(ageN == null ? ['最大保留天数要是非负整数'] : []),
        ...(durN == null ? ['最短时长要是非负整数'] : []),
        ...badKinds.map((k) => `跳过形态只有 video/article/note：${k}`)
      ]

      const charterValue = charterDraft ?? (pref?.charter ?? '')
      const delta = pref?.tuning?.source_delta ?? {}
      const deltaIds = Object.keys(delta).sort()
      const flag = (key, label, hint, value) => vnode('label', { className: 'bl-setflag' }, [
        vnode('input', {
          type: 'checkbox', 'aria-label': key, checked: value !== false, disabled: readOnly || busy || undefined,
          onChange: (e) => onSave?.(key, Boolean(e?.target?.checked), `${label}已更新`)
        }),
        label,
        hint ? vnode('span', { className: 'bl-sethint' }, [hint]) : null
      ].filter(Boolean))

      return vnode('div', { className: 'bl-setblock' }, [
        vnode('h4', {}, ['主题组（themes）']),
        Field({
          label: '每行一组：组名: 词1,词2（组内任一命中即算）',
          hint: '带必含/排除/权重的组这份格式存不下，去手编 preference.yaml；保存时它们原样保留。',
          children: [vnode('textarea', {
            'aria-label': '主题组', rows: 5, value: themesValue,
            disabled: readOnly || busy || undefined,
            onChange: (e) => onThemesDraft?.(e?.target?.value ?? '')
          })]
        }),
        split.advanced.length
          ? vnode('p', { className: 'bl-sethint' }, [
            `有 ${split.advanced.length} 组带必含/排除/权重字段（${split.advanced.map((t) => t.group).join('、')}），不进这个编辑框，保存时原样保留。`])
          : null,
        ERR(parsed.errors.map((e) => `第 ${e.line} 行：${e.reason}（${e.text}）`)),
        SaveBtn({ text: '保存主题组', disabled: readOnly || busy || themesBad,
          onClick: () => onSave?.('themes', [...split.advanced, ...parsed.themes], '主题组已存') }),

        vnode('h4', {}, ['排除词（redlines）']),
        Field({
          label: '逗号或换行分隔；命中即整条丢弃，优先于任何加分',
          children: [vnode('textarea', {
            'aria-label': '排除词', rows: 2, value: redlinesValue,
            disabled: readOnly || busy || undefined,
            onChange: (e) => onRedlinesDraft?.(e?.target?.value ?? '')
          })]
        }),
        SaveBtn({ text: '保存排除词', disabled: readOnly || busy,
          onClick: () => onSave?.('redlines', splitList(redlinesValue), '排除词已存') }),

        vnode('h4', {}, ['抓取时间窗（schedule）']),
        Field({
          label: '每行一个时间窗，写成 HH:MM-HH:MM',
          children: [
            vnode('textarea', {
              'aria-label': '时间窗', rows: 2, value: sched.windows,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onScheduleDraft?.({ windows: e?.target?.value ?? '' })
            }),
            vnode('div', { className: 'bl-setrow' }, [
              vnode('input', { type: 'number', 'aria-label': '每轮上限', value: sched.max_per_run,
                disabled: readOnly || busy || undefined,
                onChange: (e) => onScheduleDraft?.({ max_per_run: e?.target?.value ?? '' }) }),
              vnode('input', { type: 'number', 'aria-label': '每日上限', value: sched.max_per_day,
                disabled: readOnly || busy || undefined,
                onChange: (e) => onScheduleDraft?.({ max_per_day: e?.target?.value ?? '' }) }),
              vnode('label', { className: 'bl-setflag' }, [
                vnode('input', {
                  type: 'checkbox', 'aria-label': '只在时间窗内抓', checked: sched.off_peak_only,
                  disabled: readOnly || busy || undefined,
                  onChange: (e) => onScheduleDraft?.({ off_peak_only: Boolean(e?.target?.checked) })
                }),
                '只在时间窗内抓（off_peak_only）'
              ])
            ])
          ]
        }),
        ERR(schedErrs),
        SaveBtn({ text: '保存时间窗', disabled: readOnly || busy || schedBad,
          onClick: () => onSave?.('schedule', { windows: winLines, off_peak_only: sched.off_peak_only !== false, max_per_run: runN, max_per_day: dayN }, '时间窗已存') }),

        vnode('h4', {}, ['限额（limits）']),
        Field({
          label: '最大保留天数 / 最短时长（秒）/ 跳过形态（video/article/note，逗号分隔）',
          children: [vnode('div', { className: 'bl-setrow' }, [
            vnode('input', { type: 'number', 'aria-label': '最大保留天数', value: lim.max_age_days,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onLimitsDraft?.({ max_age_days: e?.target?.value ?? '' }) }),
            vnode('input', { type: 'number', 'aria-label': '最短时长（秒）', value: lim.min_duration_sec,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onLimitsDraft?.({ min_duration_sec: e?.target?.value ?? '' }) }),
            vnode('input', { type: 'text', 'aria-label': '跳过形态', placeholder: 'video,note（可空）', value: lim.skip_kinds,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onLimitsDraft?.({ skip_kinds: e?.target?.value ?? '' }) })
          ])]
        }),
        ERR(limErrs),
        SaveBtn({ text: '保存限额', disabled: readOnly || busy || limBad,
          onClick: () => onSave?.('limits', { max_age_days: ageN, min_duration_sec: durN, skip_kinds: kinds }, '限额已存') }),

        vnode('h4', {}, ['判断开关']),
        flag('require_theme_hit', '没有命中任何主题组的条目直接丢弃', '关掉后全靠预筛分与源权重，条目会多很多', pref?.require_theme_hit),
        flag('inject_prompt', '每轮把待判清单注入会话（判断轮的触发器）', '关掉能省一点上下文', pref?.inject_prompt),

        vnode('h4', {}, ['章程（charter）']),
        Field({
          label: '写给判断那轮的话：给谁筛、什么算值得看',
          children: [vnode('textarea', {
            'aria-label': '章程', rows: 3, value: charterValue,
            disabled: readOnly || busy || undefined,
            onChange: (e) => onCharterDraft?.(e?.target?.value ?? '')
          })]
        }),
        SaveBtn({ text: '保存章程', disabled: readOnly || busy,
          onClick: () => onSave?.('charter', String(charterValue).replace(/\s+$/, ''), '章程已存') }),

        vnode('h4', {}, ['权重微调（tuning，只读展示）']),
        deltaIds.length
          ? vnode('ul', { className: 'bl-kv' }, deltaIds.map((id) => vnode('li', { key: id }, [`${id}: ${fmtDelta(delta[id])}`])))
          : vnode('p', { className: 'bl-kv' }, ['没有偏移']),
        vnode('p', { className: 'bl-sethint' }, ['偏移由面板上的「这源多来点 / 不感兴趣」写入（限幅 ±0.5），这里只能看和一键归零。']),
        askResetTuning
          ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认归零权重偏移' }, [
            vnode('p', {}, [`确认把 ${deltaIds.length} 处权重偏移全部归零？下一轮抓取就从零开始调。`]),
            vnode('button', { type: 'button', onClick: () => onCancelResetTuning?.() }, ['取消']),
            vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onResetTuning?.() }, ['确认归零'])
          ])
          : vnode('button', { type: 'button', className: 'bl-setsave', disabled: busy || undefined, onClick: () => onAskResetTuning?.() }, ['一键归零'])
      ].filter(Boolean))
    }

    /* ---------------- 页签三：凭据与环境 ---------------- */

    function CredsTab({ cred, env, cookieDraft = '', onCookieDraft, onCookieSubmit,
      diagText = null, onCopyDiag, busy = false }) {
      const bili = cred?.bili
      const cookieStatus = bili == null
        ? 'B 站 cookie：状态还没读到'
        : bili.present
          ? `B 站 cookie：已写入（更新于 ${fmtTime(bili.updated_at)}，内容不回显）`
          : 'B 站 cookie：还没写入'
      const envLines = env == null
        ? ['环境探测还没读到']
        : [
          `Node：${env.node ?? '—'}`,
          `yt-dlp：${env.yt_dlp ? env.yt_dlp : '没探测到（yt 源抓取会失败）'}`,
          `库大小：${fmtBytes(env.db_bytes)}`,
          `家目录：${env.home_writable === false ? '不可写（检查磁盘权限）' : '可写'}`
        ]
      return vnode('div', { className: 'bl-setblock' }, [
        vnode('h4', {}, ['B 站凭据']),
        vnode('p', { className: 'bl-kv' }, [cookieStatus]),
        Field({
          label: '从浏览器整段粘贴 cookie（写入后这里清空，内容永不回显）',
          hint: '文件落在本机 credentials/bili-cookie.txt，日志只记字节数。',
          children: [
            vnode('textarea', {
              'aria-label': 'B 站 cookie', rows: 3, placeholder: '整段粘进来', value: cookieDraft,
              disabled: busy || undefined, onChange: (e) => onCookieDraft?.(e?.target?.value ?? '')
            }),
            SaveBtn({ text: '写入 cookie', disabled: busy || !String(cookieDraft).trim(), onClick: () => onCookieSubmit?.(cookieDraft) })
          ]
        }),
        vnode('h4', {}, ['环境']),
        vnode('ul', { className: 'bl-kv' }, envLines.map((l, i) => vnode('li', { key: i }, [l]))),
        vnode('p', { className: 'bl-empty' }, ['小红书：未接入（M4b 待做）']),
        vnode('p', { className: 'bl-empty' }, ['转写依赖：未实现（随 ASR 一起）']),
        vnode('h4', {}, ['诊断']),
        vnode('div', { className: 'bl-setrow' }, [
          vnode('button', { type: 'button', className: 'bl-setsave', disabled: busy || undefined, onClick: () => onCopyDiag?.() },
            ['复制诊断（最近 50 行，已脱敏）'])
        ]),
        diagText != null ? vnode('pre', { className: 'bl-diagtext' }, [diagText]) : null
      ].filter(Boolean))
    }

    /* ---------------- 页签四：库 ---------------- */

    function LibTab({ home, cleanupDays = '', onCleanupDays, askCleanup = false, onAskCleanup,
      onCancelCleanup, onCleanup, wipeText = '', onWipeText, onWipe, onExport, readOnly = false, busy = false }) {
      const days = Number(cleanupDays)
      const daysOk = Number.isInteger(days) && days >= 1
      return vnode('div', { className: 'bl-setblock' }, [
        vnode('h4', {}, ['数据目录']),
        vnode('p', { className: 'bl-kv' }, [`数据目录：${home ?? '<HOME>'}/baleen（sqlite、日志、备份、导出都在这里）`]),
        vnode('h4', {}, ['导出']),
        vnode('p', { className: 'bl-sethint' }, ['全部条目按源分组写成 Markdown，落在 out/ 目录。']),
        SaveBtn({ text: '导出 Markdown（未判条目也全量带上）', disabled: readOnly || busy, onClick: () => onExport?.() }),
        vnode('h4', {}, ['按天数清理归档']),
        Field({
          label: '删除入库超过 N 天的归档条目（new/judged 不动，先自动备份）',
          children: [vnode('div', { className: 'bl-setrow' }, [
            vnode('input', { type: 'number', 'aria-label': '清理天数', placeholder: '如 30', value: cleanupDays,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onCleanupDays?.(e?.target?.value ?? '') }),
            askCleanup
              ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认清理归档' }, [
                vnode('p', {}, [`将删除入库超过 ${cleanupDays} 天的归档条目（先自动备份）。已判与待判的不动。`]),
                vnode('button', { type: 'button', onClick: () => onCancelCleanup?.() }, ['取消']),
                vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onCleanup?.() }, ['确认清理'])
              ])
              : vnode('button', { type: 'button', className: 'bl-setsave', disabled: readOnly || busy || !daysOk || undefined,
                onClick: () => onAskCleanup?.() }, ['按天数清理'])
          ])]
        }),
        vnode('h4', {}, ['清空库（不可撤销，靠备份救）']),
        vnode('p', { className: 'bl-seterr' }, ['清空库：删除全部条目、抓取记录与汇报（先自动备份；收藏夹与游标保留）。']),
        Field({
          label: '输入「清空库」三个字，按钮才会亮',
          children: [vnode('div', { className: 'bl-setrow' }, [
            vnode('input', { type: 'text', 'aria-label': '清空库确认字', placeholder: '清空库', value: wipeText,
              disabled: busy || undefined,
              onChange: (e) => onWipeText?.(e?.target?.value ?? '') }),
            vnode('button', {
              type: 'button', className: 'bl-danger',
              disabled: busy || wipeText !== '清空库' || undefined,
              onClick: () => onWipe?.()
            }, ['清空库'])
          ])]
        })
      ].filter(Boolean))
    }

    /* ---------------- 顶层：页签条 + 当前页签 ---------------- */

    function SettingsPage(props) {
      const { tab = 'sources', onPickTab, note = '' } = props
      const body = tab === 'pref' ? PrefsTab(props)
        : tab === 'creds' ? CredsTab(props)
          : tab === 'library' ? LibTab(props)
            : SourcesTab(props)
      return vnode('div', { className: 'bl-settings' }, [
        vnode('aside', { className: 'bl-folderlist', 'aria-label': '设置页签' },
          SETTINGS_TABS.map(([id, label]) => vnode('button', {
            type: 'button', key: id, className: 'bl-foldertab', 'data-tab': id,
            'aria-current': tab === id ? 'page' : 'false',
            onClick: () => onPickTab?.(id)
          }, [label]))),
        vnode('div', { className: 'bl-settings-body' }, [
          note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
          body
        ].filter(Boolean))
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

    /** 导航项 ↔ 渲染器。VIEW_RENDER 的键必须与 view-state 的 VIEWS 一字不差（测试守着）。
     *  六个值全是视图本身：收藏页要多带的夹列表、草稿与二次确认态由 Panel 在调用时并进 props
     *  （那些 state 只存在于组件里，包在 VIEW_RENDER 里反而取不到）。 */
    const VIEW_RENDER = {
      today: TodayView, video: VideoView, article: ArticleView,
      collections: CollectionsView, digest: DigestView, library: LibraryView
    }

    /** 面板里"活着"的条目：归档的只在「库」里看。一次 IN 查询，不靠多次请求拼。 */
    const LIVE_STATUS = 'new,judged,digest'

    /**
     * 每个视图自己的取数形状（提到 Panel 外面，这样能被测试直接调，不用假 React）。
     * 收藏格两条特例：① 按当前夹筛（folderId 为 null 时连参数都不发——那是"没读到夹"，
     * 不是"筛了个空夹"）；② 不带 status 筛——收过的条目就算归档了也要在这页看得见（spec D15）。
     */
    function viewQuery(view, folderId) {
      if (view === 'library') return { limit: 500 }
      if (view === 'collections') return { ...(folderId == null ? {} : { folder: folderId }), limit: 200 }
      return { status: LIVE_STATUS, limit: 200 }
    }

    /** 取数的请求序号（终审 C14）：只在工厂作用域，Panel 每帧重跑不能把它清零。 */
    let refreshSeq = 0

    function Panel() {
      // api 与首屏状态都得只建一次：useState 的惰性初始化是唯一入口（useMemo 在桩里等价于直接调）
      const [api] = React.useState(() => createApi({ fetch: globalThis.fetch, storage: globalThis.localStorage }))
      const [snap, setSnap] = React.useState(() => decodeState(globalThis.localStorage && globalThis.localStorage.getItem(VIEW_KEY)))
      const [data, setData] = React.useState({ state: null, items: [], stale: false })
      const [busy, setBusy] = React.useState(false)
      const [runError, setRunError] = React.useState('')
      const [feedbackMsg, setFeedbackMsg] = React.useState('')
      // 抽屉的收藏多选：夹列表跟着数据一起刷；新夹名是装配层持有的瞬时输入（不进 reducer）；
      // collecting 防连点叠请求；knownFolders 记收藏成功后服务端读回的归属（按条目 id 用）。
      const [folders, setFolders] = React.useState([])
      const [newFolderName, setNewFolderName] = React.useState('')
      const [collecting, setCollecting] = React.useState(false)
      // 建夹/改名/删除的在途标记（终审 #18，照抄 collecting 的规矩）：没有它，双击建夹
      // 第二次会拿到 name_taken，回显对着刚建好的夹说"已经有这个夹了"。
      const [folderBusy, setFolderBusy] = React.useState(false)
      const [knownFolders, setKnownFolders] = React.useState(null)
      // 收藏页的瞬时态（一律不进 reducer：刷新就没的输入草稿 + 一次二次确认 + 一行回显）。
      // renameId 记着"这份草稿是改哪个夹的"，换夹就丢掉，不许把上一个夹的半截名字带过去。
      const [pendingDelete, setPendingDelete] = React.useState(null)
      const [folderDraft, setFolderDraft] = React.useState({ createName: '', renameId: null, renameName: '' })
      const [collectNote, setCollectNote] = React.useState('')

      const pickView = (v) => dispatch({ type: 'pick-view', view: v })
      function dispatch(action) {
        const next = reduce(snap, action)
        setSnap(next)
        try { globalThis.localStorage.setItem(VIEW_KEY, encodeState(next)) } catch { /* 存不上不影响这一屏 */ }
      }

      /**
       * 取数：先读夹表，再按"这一屏真正看的是哪个夹"读条目。
       * 顺序是有原因的——收藏格的 folder 参数要从刚读回的夹表里解析；
       * 用上一帧的 folders 解析会在首帧拿到 null，于是捞回一批"没筛夹"的全量条目，
       * 而那一屏马上就有东西可画了，读回失败被悄悄说成"这个夹里有内容"。
       * 夹表读不到时 setFolders([])：视图据此说"夹列表没读回来"，不假装是空的。
       * 连点两个夹会有多个 refresh 同时在途：谁后到谁回填，先点的那份旧响应就会盖掉后点的夹
       * （左列高亮新夹、右区还是旧夹的条目）。所以每次自增请求序号，响应落地前比对，
       * 过期的整份丢弃——setFolders 与 setData 都要罩住，只罩一半就各坏一半；
       * runFolder 成功后的 setFolders(r.data.folders) 是动作应答不是取数，不走也不受这条管。
       */
      function refresh(view = snap.view) {
        const myReq = ++refreshSeq
        const f = snap.filters[view] || {}
        return api.folders().then((fo) => {
          if (myReq !== refreshSeq) return undefined
          const list = fo && fo.ok && Array.isArray(fo.data?.folders) ? fo.data.folders : []
          setFolders(list)
          const folderId = view === 'collections' ? currentFolderId(list, f) : null
          return Promise.all([api.state(), api.items(viewQuery(view, folderId))])
            .then(([s, it]) => {
              if (myReq !== refreshSeq) return undefined
              setData({ state: s.data, items: (it.data && it.data.items) || [], stale: !s.ok })
            })
        })
      }
      React.useEffect(() => { refresh() }, [snap.view, snap.filters.collections?.folder])

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
      // 收藏页的当前夹与改名草稿都按"刚读回的夹表"解析，视图与装配层用同一个 helper，不会两处各算一套
      const curFolderId = view === 'collections' ? currentFolderId(folders, snap.filters[view] || {}) : null
      /**
       * 夹的增删改名。两条硬规矩：
       *  1. 失败必须回显（按 res.ok / res.error 分支），不许 .catch(() => {})——点了不知道有没有记上，
       *     等于把黑盒交给用户；
       *  2. 2xx 但应答里没带夹表（{ok:true, data:null}）算"没读回来"，不许把 okText 当真成功。
       */
      function runFolder(action, args, okText) {
        // 发请求前置忙、then 回调第一行复位（终审 #18）：folderOp 是 post 包装、从不 reject
        // （view-api.js 的 post 全程 try/catch），所以复位不用 finally，更不许补一个静默 catch。
        setFolderBusy(true)
        return api.folderOp(action, args).then((r) => {
          setFolderBusy(false)
          if (r.ok) {
            const list = Array.isArray(r.data?.folders) ? r.data.folders : null
            if (list) setFolders(list)
            setCollectNote(list ? okText : `没确认成：${action === 'delete' ? '删夹' : action === 'rename' ? '改名' : '建夹'}的请求发出去了，但${readbackMiss('服务端读回的夹表')}——左边还是上一次读到的那份`)
            if (action === 'delete') setPendingDelete(null)
            setFolderDraft({ createName: '', renameId: null, renameName: '' })
            return refresh()
          }
          setCollectNote(r.error === 'name_taken' ? '已经有这个夹了'
            : r.error === 'name_too_long' ? '夹名最多 40 个字'
              : r.error === 'bad_name' ? '夹名不能是空的'
                : r.error === 'default_folder' ? '默认夹删不掉（它是随手一收的落点）'
                  : r.error === 'no_folder' ? '这个夹已经没了（可能是另一格刚删的）'
                    : `没记上（${r.error || '宿主接口没应答'}）`)
          return undefined
        })
      }
      // 收藏页专属的那一叠：夹表、二次确认态、两个输入框的草稿与一行回显。
      // 这份对象每帧都建（只是几个闭包），但只并进收藏格的 props，别的视图拿到也不认。
      const collectionsProps = {
        folders,
        pendingDelete,
        folderBusy,
        note: collectNote,
        newFolderName: folderDraft.createName,
        // 无草稿传 null（不是空串）：视图靠 null 回落服务端夹名；空串是"用户清空了草稿"，
        // 传成空串会把清空误当没草稿，一松手就被旧名填回（终审 #15）。
        currentName: folderDraft.renameId === curFolderId ? folderDraft.renameName : null,
        onNewFolderNameChange: (v) => setFolderDraft((d) => ({ ...d, createName: v })),
        onCurrentNameChange: (v) => setFolderDraft((d) => ({ ...d, renameId: curFolderId, renameName: v })),
        onPickFolder: (id) => { setPendingDelete(null); dispatch({ type: 'filter', view: 'collections', key: 'folder', value: id }) },
        onCreate: (name) => runFolder('create', { name }, `建好了：${name}`),
        onRename: (id, name) => runFolder('rename', { id, name }, `已改名为「${name}」`),
        onAskDelete: (id) => setPendingDelete(id),
        onCancelDelete: () => setPendingDelete(null),
        onDelete: (id) => runFolder('delete', { id }, '夹删了，里面的条目一条都没动')
      }
      const baseProps = {
        state: st,
        items: data.items,
        filters: snap.filters[view] || {},
        selectedId: snap.selectedId,
        // 汇报跟着 /state 走（M3 起 state.digests 已由服务端把 stats_json 解成对象）；
        // 读不到或没有时给空数组，DigestView 会用 state.digest_count 说"数得出读不出来"
        digests: (st && Array.isArray(st.digests)) ? st.digests : [],
        busy,
        onRun,
        onFilter: dispatch,
        onFacet: dispatch,
        onSelect: (id) => dispatch({ type: 'select', id }),
        onOpen: (id) => dispatch({ type: 'open-drawer', id }),
        onPickView: pickView
      }
      const body = render(view === 'collections' ? { ...baseProps, ...collectionsProps } : baseProps)
      const drawerOpen = snap.drawerItemId != null
      const found = drawerOpen ? data.items.find((i) => i.id === snap.drawerItemId) || null : null
      // 抽屉里那条可能来自不带 folders 字段的查询（今天的三格）。/collect 是全量替换，
      // 所以收藏成功后要把服务端读回的归属覆盖上去——只覆盖抽屉这一条的展示，不改 data.items。
      // 覆盖规则抽成纯函数 drawerItemWithFolders（views/drawer.js），连点不互抹的不变量由测试钉住。
      const drawerItem = drawerItemWithFolders(found, knownFolders)
      // 包一层 collecting：点一下即生效意味着连点会叠请求，全量替换下后到的旧集合会盖掉新决定。
      function runCollect(...args) {
        setCollecting(true)
        return api.collect(...args).then(
          (r) => { setCollecting(false); return r },
          (e) => { setCollecting(false); throw e }
        )
      }
      return h('div', { className: 'bl-root' }, [
        // 外壳三件（Nav / TopBar / NotReady）与视图同构，都产纯对象，所以一律经 toElement，
        // 不能 h(Nav)：函数组件返回普通对象的话，真 React 会直接抛"Objects are not valid as a React child"。
        toElement(TopBar({ stale: data.stale, runError, preferenceErrors: st && st.preference_errors })),
        toElement(Nav({ view, pending, onPick: pickView })),
        h('main', { key: 'body', className: 'bl-body' }, toElement(body)),
        drawerOpen
          ? toElement(Drawer({
            item: drawerItem,
            api: { ...api, collect: runCollect },
            note: feedbackMsg,
            folders,
            collecting,
            newFolderName,
            onNewFolderName: setNewFolderName,
            onClose: () => { setFeedbackMsg(''); setNewFolderName(''); dispatch({ type: 'close-drawer' }) },
            onDone: (r) => {
              setFeedbackMsg(r.message)
              // 只有成功（带读回的 folderIds）才清输入框并覆盖归属；失败留住名字好重试。
              if (r.kind === 'collect' && r.folderIds) {
                setNewFolderName('')
                if (drawerItem) setKnownFolders({ itemId: drawerItem.id, folder_ids: r.folderIds })
                if (Array.isArray(r.folders)) setFolders(r.folders)
              }
            }
          }))
          : null
      ])
    }

    /**
     * 设置页（settings.section 槽）的装配树：与 Panel 平行的另一棵，取数走 view-api 的设置面，
     * 视图（views/settings.js）保持纯函数可单测。四页签的 tab、各节草稿、确认态全在组件里——
     * 不进 view-state 的 reducer：那套是主面板六格导航的账本，设置页的生命周期跟着宿主设置页走。
     *
     * 安全闸：偏好**没读到**（loaded=false 或 pref=null）时整个页签只读——
     * 盲发 sources 全量 PUT 等于用一个空数组把现有源全部抹掉。
     */
    function SettingsView() {
      const [api] = React.useState(() => createApi({ fetch: globalThis.fetch, storage: globalThis.localStorage }))
      const [loaded, setLoaded] = React.useState(false)
      const [pref, setPref] = React.useState(null)
      const [hostState, setHostState] = React.useState(null)
      const [cred, setCred] = React.useState(null)
      const [env, setEnv] = React.useState(null)
      const [tab, setTab] = React.useState('sources')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // 源页签
      const [srcDraft, setSrcDraft] = React.useState({ id: '', type: 'rss', url: '', label: '', interval_min: '', weight: '' })
      const [askDelete, setAskDelete] = React.useState(null)
      // 偏好页签的草稿：null = 没动过，视图回落 preference 现值（换页签不丢，关宿主设置页才丢——草稿本就是瞬时的）
      const [themesDraft, setThemesDraft] = React.useState(null)
      const [redlinesDraft, setRedlinesDraft] = React.useState(null)
      const [scheduleDraft, setScheduleDraft] = React.useState(null)
      const [limitsDraft, setLimitsDraft] = React.useState(null)
      const [charterDraft, setCharterDraft] = React.useState(null)
      const [askResetTuning, setAskResetTuning] = React.useState(false)
      // 凭据页签
      const [cookieDraft, setCookieDraft] = React.useState('')
      const [diagText, setDiagText] = React.useState(null)
      // 库页签
      const [cleanupDays, setCleanupDays] = React.useState('')
      const [askCleanup, setAskCleanup] = React.useState(false)
      const [wipeText, setWipeText] = React.useState('')

      function refresh() {
        return Promise.all([api.preferenceGet(), api.state(), api.credentialStatus(), api.envCheck()]).then(([p, st, c, e]) => {
          if (p.ok && p.data) {
            setPref(p.data.pref ?? {})
            // 坏文件上服务端会退默认值照常回 pref：不把 errors 亮出来，这页显示的就是
            // "假默认"，用户一保存还会被 preference_invalid 打回——先说清文件本身坏了。
            const errs = Array.isArray(p.data.errors) ? p.data.errors : []
            if (errs.length) setNote(`preference.yaml 有 ${errs.length} 处问题：${errs.slice(0, 2).join('；')}——先手编修好，这期间的保存都会被拒`)
          } else if (p.stale) {
            setNote('偏好没读到（宿主接口没应上）——先别保存任何一节，等下一次打开再试')
          }
          if (st.ok) setHostState(st.data)
          if (c.ok && c.data) setCred(c.data)
          if (e.ok && e.data) setEnv(e.data)
          setLoaded(true)
        })
      }
      React.useEffect(() => { refresh() }, [])

      const readOnly = !(loaded && pref != null)
      const sources = Array.isArray(pref && pref.sources) ? pref.sources : []

      /** PUT 一节偏好：读-改-写。失败回显优先服务端的错误清单（400 带 errors 的是"值不合法"）。 */
      function putSection(section, value, okText) {
        setBusy(true)
        return api.preferencePut(section, value).then((r) => {
          setBusy(false)
          if (r.ok) {
            if (r.data && r.data.pref) setPref(r.data.pref)
            setNote(okText)
            return true
          }
          const errs = Array.isArray(r.data && r.data.errors) ? r.data.errors : null
          setNote(errs && errs.length ? `没存上：${errs.slice(0, 3).join('；')}` : `没存上（${r.error || '宿主接口没应答'}）`)
          return false
        })
      }
      function putSources(next, okText) { return putSection('sources', next, okText) }
      function onToggleSource(id, next) {
        if (!sources.some((s) => s.id === id)) return
        putSources(sources.map((s) => (s.id === id ? { ...s, enabled: next } : s)), `已${next ? '启用' : '停用'} ${id}（下一轮抓取生效）`)
      }
      function onAddSource(d) {
        const entry = { id: String(d.id).trim(), type: d.type, url: String(d.url).trim(), enabled: true }
        if (String(d.label).trim()) entry.label = String(d.label).trim()
        const iv = Number(d.interval_min)
        if (String(d.interval_min).trim() !== '' && Number.isInteger(iv)) entry.interval_min = iv
        const w = Number(d.weight)
        if (String(d.weight).trim() !== '' && Number.isFinite(w)) entry.weight = w
        putSources([...sources, entry], `源 ${entry.id} 已加（下一轮抓取才碰它）`)
          .then((ok) => { if (ok) setSrcDraft({ id: '', type: 'rss', url: '', label: '', interval_min: '', weight: '' }) })
      }
      function onDeleteSource(id) {
        putSources(sources.filter((s) => s.id !== id), `源 ${id} 已删（已抓的条目不动）`)
          .then((ok) => { if (ok) setAskDelete(null) })
      }
      function onResetTuning() {
        setBusy(true)
        api.tuningReset().then((r) => {
          setBusy(false)
          setAskResetTuning(false)
          if (r.ok) {
            setNote('权重偏移已全部归零')
            return api.preferenceGet().then((p) => { if (p.ok && p.data) setPref(p.data.pref ?? pref) })
          }
          setNote(`没归成（${r.error || '宿主接口没应答'}）——preference.yaml 坏了的话先手编修好`)
          return undefined
        })
      }
      /** 凭据写入：成功清输入框（零回显的一半），状态行换成应答里的新状态（另一半）。 */
      function onCookieSubmit(content) {
        setBusy(true)
        api.credentialPut('bili', content).then((r) => {
          setBusy(false)
          if (r.ok) {
            setCookieDraft('')
            if (r.data && r.data.bili) setCred(r.data)
            setNote('cookie 已写入（内容不回显，只记了字节数进日志）')
            return api.envCheck().then((e) => { if (e.ok && e.data) setEnv(e.data) })
          }
          setNote(r.error === 'bad_payload' ? '空内容写不进去——整段粘贴后再按' : `没写上（${r.error || '宿主接口没应答'}）`)
          return undefined
        })
      }
      /** 复制诊断：tail 已在服务端逐行脱敏；剪贴板拿不到就降级成文本块让人手动复制。 */
      function onCopyDiag() {
        api.diagTail(50).then((r) => {
          if (!r.ok) { setNote(`诊断没读到（${r.error || '宿主接口没应答'}）`); return }
          const lines = Array.isArray(r.data && r.data.lines) ? r.data.lines : []
          const text = lines.join('\n')
          const clip = (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function')
            ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))
          clip.then(
            () => setNote(`诊断已复制（最近 ${lines.length} 行，已脱敏）`),
            () => { setDiagText(text || '（日志还是空的）'); setNote('剪贴板拿不到，诊断贴在下面——自己复制') }
          )
        })
      }
      function onExport() {
        setBusy(true)
        api.exportMd().then((r) => {
          setBusy(false)
          setNote(r.ok ? `${r.data.file} · ${r.data.bytes} 字节（out/ 目录里）` : `没导成（${r.error || '宿主接口没应答'}）`)
        })
      }
      function onCleanup() {
        const days = Number(cleanupDays)
        setBusy(true)
        api.cleanup(days).then((r) => {
          setBusy(false)
          if (r.ok) {
            setAskCleanup(false)
            setNote(`清了 ${r.data.removed} 条归档，备份：${r.data.backup}`)
          } else {
            setNote(r.error === 'running' ? '有一轮抓取正在跑，等它完再清理' : `没清成（${r.error || '宿主接口没应答'}）`)
          }
        })
      }
      function onWipe() {
        setBusy(true)
        api.wipe(wipeText).then((r) => {
          setBusy(false)
          if (r.ok) {
            const rm = r.data.removed || {}
            setWipeText('')
            setNote(`已清空：条目 ${rm.items ?? '?'} · 轮次 ${rm.runs ?? '?'} · 汇报 ${rm.digests ?? '?'}，备份：${r.data.backup}`)
            return api.state().then((st) => { if (st.ok) setHostState(st.data) })
          }
          setNote(r.error === 'running' ? '有一轮抓取正在跑，等它完再清空'
            : r.error === 'confirm_required' ? '确认字没对上——要输入「清空库」三个字'
              : `没清成（${r.error || '宿主接口没应答'}）`)
          return undefined
        })
      }

      const page = SettingsPage({
        loaded, pref, hostState, note, busy, readOnly,
        tab, onPickTab: setTab,
        sources, srcDraft, onSrcDraft: (patch) => setSrcDraft((d) => ({ ...d, ...patch })),
        askDelete, onAskDelete: setAskDelete, onCancelDelete: () => setAskDelete(null),
        onToggleSource, onAddSource, onDeleteSource,
        themesDraft, onThemesDraft: setThemesDraft,
        redlinesDraft, onRedlinesDraft: setRedlinesDraft,
        scheduleDraft, onScheduleDraft: (patch) => setScheduleDraft((d) => ({ ...(d ?? {}), ...patch })),
        limitsDraft, onLimitsDraft: (patch) => setLimitsDraft((d) => ({ ...(d ?? {}), ...patch })),
        charterDraft, onCharterDraft: setCharterDraft,
        onSave: putSection,
        askResetTuning, onAskResetTuning: () => setAskResetTuning(true), onCancelResetTuning: () => setAskResetTuning(false), onResetTuning,
        cred, env, cookieDraft, onCookieDraft: setCookieDraft, onCookieSubmit, diagText, onCopyDiag,
        home: hostState?.home ?? '<HOME>',
        cleanupDays, onCleanupDays: setCleanupDays, askCleanup, onAskCleanup: () => setAskCleanup(true), onCancelCleanup: () => setAskCleanup(false), onCleanup,
        wipeText, onWipeText: setWipeText, onWipe, onExport
      })
      return h('div', { className: 'bl-root' }, [toElement(page)])
    }

    function apply(ctx) {
      clientCtx = ctx
      injectStyles()
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
                return toElement(NotReady({ text: '这一格渲染失败：' + where }))
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

      // 设置页（M5，V4 闭环）：meta 形状照抄本机 study-desk 的实测（order 27 是它，28 紧随其后）
      reg('settings.section',
        { name: 'settings.section', id: 'baleen-settings', order: 28, label: 'Baleen' },
        () => h(SettingsView, { key: 'settings' }),
        'settings.section')

      return { registeredSlots: registered }
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      PANEL_ID, VIEW_KEY, API_BASE, SNAPSHOT_KEY, VIEWS, VIEW_RENDER, viewQuery, NAV_ITEMS,
      Nav, NotReady, TopBar, Panel, toElement, createApi, getLayout, safeGet,
      reduce, encodeState, decodeState, TodayView, Drawer, CollectionsView,
      SettingsView, SettingsPage, parseThemes, serializeThemes, splitThemes
    }
    return module.exports
  }
})
