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
    const API = '/api/dsh-baleen'

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

    const KEY_SNAPSHOT = 'baleen.snapshot'

    /**
     * 取数层。三条硬规矩：
     *  - 失败绝不抛到渲染层：回 { ok:false, stale:true, data:上次快照 }，顶栏据此出灰条；
     *  - 快照只存"能渲染的状态"，不存正文（真相在 sqlite 里）；
     *  - feedback 的动作是白名单，不让调用方塞任意 delta。
     */
    function makeStore({ fetch: fetchImpl = globalThis.fetch, storage = globalThis.localStorage, actions = { dismiss: -0.1, save: 0.1 } } = {}) {
      function write(obj) {
        try { storage.setItem(KEY_SNAPSHOT, JSON.stringify(obj)) } catch { /* 存不下就算了 */ }
      }
      function readCached() {
        try {
          const t = storage.getItem(KEY_SNAPSHOT)
          const p = t ? JSON.parse(t) : null
          return p && typeof p === 'object' ? p : null
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
        readCached,
        state: () => get(API + '/state'),
        items: (q) => get(API + '/items?' + new URLSearchParams(q || {}).toString()),
        async run() {
          const r = await call(API + '/run', { method: 'POST' })
          if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
          const next = r.json && r.json.state ? r.json.state : r.json
          if (next) write(next)
          return { ok: true, stale: false, data: r.json }
        },
        async feedback(sourceId, action) {
          if (!Object.prototype.hasOwnProperty.call(actions, action)) throw new Error('未知动作：' + action)
          if (!sourceId) throw new Error('feedback 需要 source_id')
          const r = await call(API + '/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source_id: sourceId, action })
          })
          if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
          return { ok: true, stale: false, data: r.json }
        }
      }
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

    function Panel() {
      return h('div', { className: 'bl-root' }, [
        h(Nav, { key: 'nav', view: 'today', pending: 0, onPick: () => {} }),
        h('main', { key: 'body', className: 'bl-body' }, h(NotReady, { text: '面板装配中（M2 后续任务填视图）' }))
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
    exports.__test = { PANEL_ID, API, KEY_SNAPSHOT, Nav, NotReady, makeStore, getLayout, safeGet }
    return module.exports
  }
})
