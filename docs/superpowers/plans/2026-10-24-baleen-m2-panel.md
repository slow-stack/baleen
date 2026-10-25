# Baleen M2（三区面板）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Baleen 做出门户式面板：侧边栏一个入口，进来是顶部五项导航（今天 / 视频 / 文章 / 汇报 / 库），卡片墙 + 抽屉详情，明暗双主题只消费宿主 token，视图与筛选状态在重启后能还原。

**Architecture:** 客户端半（`client.js`）只做"取数据 + 渲染 + 把用户动作发给宿主路由"，所有渲染器是纯函数（输入数据 → 节点树），因此可以在纯 Node 里用 `tools/client-loader.mjs` 载进来测。宿主半 M1 已经提供 `/api/dsh-baleen/{state,items}`，M2 只加两个读写点：`POST /run`（手动跑一轮，已有）与 `POST /feedback`（两个粗调按钮，只写 `tuning`）。

**Tech Stack:** `window.__ModuleLoader__.load` 格式的客户端 bundle（无打包器）、`require('react')` 拿 `createElement`、`node --test`（唯一测试框架）、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-23-baleen-design.md` §8（前端）与 §9（设置页只留槽位，不做内容）；本计划做完 M2 时**没有判断轮**（M3），所以汇报区必须是明确的空态。

## Global Constraints

- 侧边栏 `sidebar.panellist` 注册的 `id` 与 `main` 的 `key` **必须完全同名**（都用 `baleen`），否则宿主 `layout.selectPanel` 抛。
- 客户端 `package.json` 的 `dsh.client.inject` 与代码里的 `const inject = [...]` 必须一致；**DSH 客户端 `ctx` 是 Proxy**，任何未声明服务的 `ctx.get()` 和属性访问都抛。所有跨服务读取都要包 `try`，**不许 `try { ctx.get(x) } catch {}` 之后再去裸读 `ctx.x`**（那是炸启动的写法，不是降级）。
- **一个硬编码颜色都不许有**。只消费 `--dsw-alias-*` / `--dsw-static-*`；预览用的 fallback 必须写成 `var(--dsw-alias-x, <fallback>)` 形式，且 fallback 用 `light-dark()` 同时给明暗两值。
- 布局不许在两侧留大空白：卡片网格一律 `repeat(auto-fill, minmax(232px, 1fr))`，容器 `width: 100%`，不固定外层宽度。
- 字号只用 13px 正文 / 12px 次要 / 11px 徽章；字重只有 400 与 500；可点目标 ≥ 32px 高。
- 尊重 `prefers-reduced-motion`：切换视图用交叉淡入，不要位移动画。
- **不许把没有的东西画成有**：M2 阶段汇报区没有真数据，必须显示"判断轮未接入（M3）"的空态，禁止用假总结充数。
- 待判数量必须显式可见（`counts.new`），且措辞是"待判 N 条"，不能说成"已筛 N 条"。
- 视图状态（当前视图、筛选、抽屉打开的条目、滚动位置）持久化到 `localStorage`，键名前缀 `baleen.`；切走再回来必须还原。
- 所有渲染器是**纯函数**：不读全局、不发请求、不直接改状态；数据一律从参数进。
- 测试通过 `tools/client-loader.mjs` 在纯 Node 里载 `client.js`，用 `exports.__test` 取内部函数。**桩文件不放 `test/` 下**（`node --test` 会把 test 目录每个文件当测试跑，无断言的文件会变成假绿）。
- 提交信息中文；一个任务一次提交；`npm test` 全绿才许进下一个任务。

## 文件结构

客户端半必须是**单文件 loader bundle**（DSH 的 `ModuleLoader` 直接吃，没有打包器），但纯逻辑不能写成一大坨。所以：源文件放 `src/client/`，由 `tools/build-client.mjs` 拼成 `client.js`，并有一条测试盯着"改了源忘了生成"。

```
src/client/view-state.js       纯 reducer：导航、筛选、抽屉、还原；localStorage 编解码
src/client/view-api.js         取数：state / items / run / feedback；失败回落上次快照
src/client/css.js              CSS 字符串（只消费 --dsw-alias-*，每个 token 配 light-dark fallback）
src/client/views/today.js      「今天」：统计行 + 跳过明细 + 待判提示 + 双轨道卡片
src/client/views/video.js      「视频」：工具条 + 网格 + 档位徽章 + 播放能力说明
src/client/views/article.js    「文章」：列表 + 正文两栏 + 「源只给摘要」的措辞
src/client/views/digest.js     「汇报」：历史 + M3 未接入的诚实空态
src/client/views/library.js    「库」：facet 组合筛选 + 全量网格
src/client/views/drawer.js     抽屉：命中理由 / 原文 / 能力边界 / 两个反馈按钮
src/client/_header.txt           loader 外壳（load({id, factory}) + React + 槽位注册 + Panel 装配）
src/client/_footer.txt           exports.apply / inject / __test 与闭合
client.js                      ← 生成物，不要手改（test/build.test.js 会红）
tools/build-client.mjs         拼接生成，支持 --check
tools/preview.mjs              用同一批渲染函数出假数据 HTML（明暗两版），验收门
tools/client-loader.mjs        纯 Node 载入客户端半的桩（复刻 loader/React/Proxy ctx/fetch）
index.js                       宿主半：加 POST /feedback，state() 加 digest_count
lib/store.js                   加 markFeedback（只留痕，不影响权重）
test/client-boot.test.js       槽位注册形状、id 同名、inject 一致、缺服务不炸
test/view-state.test.js        reducer 与持久化往返、坏数据回落
test/view-api.test.js          取数、快照回落、feedback 白名单
test/views*.test.js            各视图的树断言（空态、待判、徽章文案、能力边界）
test/css.test.js               无硬编码颜色、auto-fill 网格、字号与字重白名单
test/build.test.js             client.js 与生成结果一致
test/preview.test.js           预览出六份 HTML、明暗两块、空态也渲染
test/fixtures/preview-data.js  预览与断言共用的假数据（真结构、假标题）
```

一个视图一个文件；`client.js` 只负责装配和注册——它不该长大，长到没法读就该拆视图出去而不是加 `if`。

---

## Task 0: 纯 Node 载入客户端半的桩

**Files:**
- Create: `tools/client-loader.mjs`
- Test: `test/client-boot.test.js`（本任务先只测"桩能拿到 exports"）

**Interfaces:**
- Consumes: `client.js`（Task 1 才有，本任务先写桩并允许 client.js 不存在时明确跳过）
- Produces: `loadClient() → { exports, registered, requires, captured }`，其中
  - `registered`：`slots.register(meta, factory)` 的调用记录数组
  - `captured`：`__ModuleLoader__.load` 收到的 `{id, factory}`
  - `exports.__test`：客户端内部纯函数

- [ ] **Step 1: 写桩 `tools/client-loader.mjs`**

```js
// 把 client.js 这个「宿主 loader 格式」的 bundle 在纯 Node 里载进来。
// 不放 test/ 下：node --test 会把 test 目录里每个文件当一个测试跑，
// 这个文件没有断言，混进去只会多出一条假绿。
//
// 桩刻意复刻宿主的三个事实，因为实现会读它们：
//   1. window.__ModuleLoader__.load({id, factory})，注册 id 必须等于 loader entry 名
//   2. require('react') 给 createElement；require('react-dom') 可能给 createPortal
//   3. slots.register 的返回值会被宿主拿去渲染，未声明的服务访问即抛（ctx 是 Proxy）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')

export const CLIENT_PATH = CLIENT
export function clientExists() { return fs.existsSync(CLIENT) }

export function makeStubs({ storage = {}, fetchImpl } = {}) {
  const store = { ...storage }
  const registered = []
  const injected = []
  const capturedLoader = { value: null }

  const window = {
    __ModuleLoader__: { load: (def) => { capturedLoader.value = def } },
    innerWidth: 1280, innerHeight: 800,
    addEventListener() {}, removeEventListener() {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] }
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  }
  const created = []
  const document = {
    body: null,
    documentElement: { attrs: new Set(), hasAttribute(n) { return this.attrs.has(n) }, setAttribute() {}, style: {} },
    createElement: () => { const el = { style: {}, textContent: '', setAttribute() {}, appendChild() {} }; created.push(el); return el },
    addEventListener() {}, removeEventListener() {}
  }

  const React = {
    version: 'stub',
    Fragment: Symbol.for('fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (sub, get) => get()
  }
  const ReactDOM = { createPortal: (node) => node }

  function require_(name) {
    if (name === 'react') return React
    if (name === 'react-dom') return ReactDOM
    throw new Error(`桩里没有模块：${name}`)
  }

  const slots = {
    inject: (name, fn) => { injected.push(name); registered.push({ slot: name, def: fn() }); },
    register: (meta, factory) => ({ meta, factory })
  }
  // 复刻 DSH 的 ctx Proxy 行为：没在 inject 里声明过的服务，get 与属性访问都抛
  function makeCtx(declared) {
    const set = new Set(declared)
    const target = { get: (n) => (n === 'slots' ? slots : undefined) }
    return new Proxy(target, {
      get(t, prop) {
        if (prop === 'get') return (name) => { if (!set.has(name)) throw new Error(`cannot get service "${name}" without inject`); return name === 'slots' ? slots : undefined }
        if (prop === 'provide') return () => {}
        if (prop === 'on') return () => {}
        if (prop === 'effect') return (fn) => fn()
        if (typeof prop === 'symbol') return t[prop]
        if (!set.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return t[prop]
      }
    })
  }

  const fetchStub = fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))

  return { window, document, React, require: require_, slots, registered, injected, capturedLoader, makeCtx, store, fetch: fetchStub, created }
}

export function loadClient(opts = {}) {
  if (!fs.existsSync(CLIENT)) throw new Error('client.js 还没建（Task 1）')
  const stubs = makeStubs(opts)
  globalThis.window = stubs.window
  globalThis.document = stubs.document
  globalThis.localStorage = stubs.window.localStorage
  globalThis.fetch = stubs.fetch
  globalThis.matchMedia = stubs.window.matchMedia
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.setTimeout = setTimeout
  try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true }) } catch { /* 沿用 */ }

  const fn = new Function('window', 'document', 'require', 'fetch', 'localStorage', 'matchMedia', 'requestAnimationFrame', 'navigator', 'setTimeout', stubs.window.__ModuleLoader__ && `
    ${fs.readFileSync(CLIENT, 'utf8')}
  `)
  fn(stubs.window, stubs.document, stubs.require, stubs.fetch, stubs.window.localStorage,
     stubs.window.matchMedia, globalThis.requestAnimationFrame, { userAgent: 'node' }, setTimeout)
  return stubs
}
```

`new Function` 只执行本仓库自己的 `client.js`（测试桩要跑真实现，不愿另写一份渲染算法），输入不是外部数据。

- [ ] **Step 2: 写 `test/client-boot.test.js`（本任务只验桩本身）**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { clientExists, makeStubs, loadClient } from '../tools/client-loader.mjs'

test('桩的 ctx 复刻宿主 Proxy：未声明服务访问即抛', () => {
  const s = makeStubs()
  const ctx = s.makeCtx(['slots'])
  assert.equal(ctx.get('slots'), s.slots)
  assert.throws(() => ctx.get('layout'), /without inject/)
  assert.throws(() => ctx.layout, /without inject/)
})

test('桩没有 client.js 时 loadClient 明确报错，不静默通过', () => {
  if (clientExists()) { assert.ok(loadClient().capturedLoader.value) ; return }
  assert.throws(() => loadClient(), /client\.js 还没建/)
})
```

- [ ] **Step 3: 跑测试**

Run: `node --test test/client-boot.test.js`
Expected: PASS（第二条走"还没建"分支，Task 1 之后自动改走第一条）

- [ ] **Step 4: 提交**

```bash
git add tools/client-loader.mjs test/client-boot.test.js
git commit -m "test: 纯 Node 载入客户端半的桩，复刻 ctx Proxy 行为"
```

---

## Task 1: 客户端骨架与槽位注册

**Files:**
- Create: `client.js`
- Modify: `package.json`（加 `dsh.client`）
- Test: `test/client-boot.test.js`（追加断言）

**Interfaces:**
- Consumes: `lib/view-state.js`?（不，客户端半不能 import 仓库模块——它是单文件 loader bundle；共享逻辑靠 `exports.__test` 暴露，或把纯函数复制进 `lib/view-state.js` 并由 **宿主半和客户端各自持有**。）本任务只建立：`client.js` 的 `load({id:'dsh-baleen', factory})`、`inject`、`apply(ctx)`、四个槽位注册、`exports.__test`。
- Produces:
  - `PANEL_ID = 'baleen'`（侧栏 id 与 main key 同源）
  - `exports.apply(ctx)` → 注册槽位；返回 `{ registeredSlots }` 仅用于测试
  - `exports.__test = { PANEL_ID, CSS, Nav, TodayView, VideoView, ArticleView, DigestView, LibraryView, Drawer, makeStore }`（后续任务逐个填进去）

- [ ] **Step 1: 写 `package.json` 的客户端声明**

```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  },
```

`files` 数组补 `"client.js"` 与 `"views/"`、`"lib/view-state.js"`、`"lib/view-api.js"`（宿主半也要用 view-state？不用——客户端自己那份在 `client.js` 里内联，见下方说明）。

**为什么客户端要内联而不是 `import './lib/view-state.js'`**：`dsh.client` 的 loader bundle 由宿主用 `makeRequire` 解析，静态模块只有 `react` / `react-dom` / 宿主自己的几个包；相对路径 import 能不能解析**未实测**。Task 2 会把 reducer 写成 `lib/view-state.js`，并加一条测试要求 `client.js` 内联的那份与它**逐字节一致**（用构建脚本同步，而不是靠自觉）——这条如果被实测证明能直接 import，就删掉内联，保留一份。

- [ ] **Step 2: 写失败的测试（追加到 `test/client-boot.test.js`）**

```js
test('client.js 以 loader 格式注册，id 与侧栏/主面板槽位同名', async () => {
  const s = loadClient()
  assert.equal(s.capturedLoader.value.id, 'dsh-baleen')
  assert.equal(typeof s.capturedLoader.value.factory, 'function')
  const exports = s.capturedLoader.value.factory(s.require)
  assert.deepEqual(exports.inject, ['slots', 'layout'])
  const ctx = s.makeCtx(exports.inject)
  exports.apply(ctx)
  const slots = s.registered.map(r => r.def.meta.name)
  assert.deepEqual(slots, ['sidebar.panellist', 'main'])
  const [side, main] = s.registered.map(r => r.def.meta)
  assert.equal(side.id, 'baleen')
  assert.equal(main.key, side.id)          // 不同名会让宿主 layout.selectPanel 抛
  assert.equal(typeof side.label, 'string') && assert.match(side.label, /Baleen/)
})

test('未声明的服务一律包 try：ctx 只给 slots 和 layout', async () => {
  const s = loadClient()
  const exports = s.capturedLoader.value.factory(s.require)
  const ctx = s.makeCtx(['slots'])         // 故意少声明 layout
  assert.doesNotThrow(() => exports.apply(ctx))   // 缺服务不能炸启动
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/client-boot.test.js`
Expected: FAIL — `client.js 还没建（Task 1）`

- [ ] **Step 4: 写 `client.js`**

```js
/**
 * dsh-baleen —— 客户端半
 *
 * 以 dsh.client bundle 格式加载（宿主 ModuleLoader，无打包器）。
 * 注册 id 必须等于 loader entry 名（dsh-baleen），否则宿主报
 * "loaded without registering dsh-baleen"。
 *
 * 视觉约定：一个硬编码颜色都没有——只消费 --dsw-alias-* / --dsw-static-*，
 * fallback 用 light-dark() 同时给明暗两值，所以换主题这里自动跟着变。
 *
 * 挂载点：sidebar.panellist（id 与 main 的 key 同为 baleen）、main（整页面板）。
 * 设置页在 M5 再挂 settings.section，本里程碑不注册。
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

    // ---------------------------------------------------------------- 状态槽
    // 渲染器都在下面这几个占位里，Task 2–8 逐个填实现；这里保持"纯函数 +
    // 不碰全局"的约定，因此可以脱离浏览器测。
    function NotReady({ text }) {
      return h('div', { className: 'bl-empty' }, text)
    }

    function Nav({ view, onPick, pending }) {
      const items = [['today', '今天'], ['video', '视频'], ['article', '文章'], ['digest', '汇报'], ['library', '库']]
      return h('nav', { className: 'bl-nav', 'aria-label': '主导航' }, [
        h('span', { className: 'bl-brand', key: 'b' }, 'Baleen'),
        h('div', { className: 'bl-navlist', key: 'n' }, items.map(([id, label]) =>
          h('button', {
            type: 'button', key: id, className: 'bl-navitem',
            'aria-current': view === id ? 'page' : 'false',
            onClick: () => onPick(id)
          }, label + (id === 'today' && pending ? ` ·待判${pending}` : ''))
        ))
      ])
    }

    // ---------------------------------------------------------------- 数据
    function makeStore({ fetch: fetchImpl = globalThis.fetch, storage = globalThis.localStorage } = {}) {
      const KEY = 'baleen.snapshot'
      let last = null
      async function read(url, init) {
        try {
          const res = await fetchImpl(url, init ?? { cache: 'no-store' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const json = await res.json()
          last = json
          try { storage.setItem(KEY, JSON.stringify(json)) } catch { /* 存不进去就算了 */ }
          return { ok: true, data: json }
        } catch (e) {
          let cached = null
          try { cached = JSON.parse(storage.getItem(KEY) || 'null') } catch { cached = null }
          return { ok: false, data: cached, error: String(e && e.message || e) }
        }
      }
      return {
        read,
        get last() { return last },
        state: () => read(API + '/state'),
        items: (q) => read(API + '/items?' + new URLSearchParams(q || {}).toString())
      }
    }

    // ---------------------------------------------------------------- 装配
    let clientCtx = null
    const inject = ['slots', 'layout']

    function apply(ctx) {
      clientCtx = ctx
      const slots = safeGet('slots')
      if (!slots) return { registeredSlots: [] }
      const registered = []

      const reg = (slot, meta, render, where) => {
        try {
          slots.inject(slot, () => {
            const def = slots.register(meta, (...args) => {
              try { return render(...args) } catch (e) {
                console.error('[dsh-baleen] ' + where + ' 渲染抛错：', e && e.message)
                return h(NotReady, { text: '这一格渲染失败：' + where })
              }
            })
            registered.push({ slot, def })
            return def
          })
        } catch (e) {
          console.error('[dsh-baleen] 槽位注册失败 ' + where + '：', e && e.message)
        }
      }

      reg('sidebar.panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: 'Baleen' },
        () => h('span', { className: 'bl-icon', 'aria-hidden': 'true' }, '≈'), 'sidebar.panellist')
      reg('main', { name: 'main', key: PANEL_ID }, () => h(Panel, { key: 'panel' }), 'main')
      return { registeredSlots: registered }
    }

    /** 只有声明过的服务才读得到；这条 helper 存在的意义就是不让人手写裸属性回退 */
    function safeGet(name) {
      if (!clientCtx) return undefined
      try { return typeof clientCtx.get === 'function' ? clientCtx.get(name) : undefined } catch { return undefined }
    }

    function getLayout() {
      // ctx 是 Proxy：get 抛之外，属性访问也抛。两层都要包。
      const viaGet = (() => { try { return clientCtx && clientCtx.get('layout') } catch { return null } })()
      if (viaGet) return viaGet
      try { return (clientCtx && clientCtx.layout) || null } catch { return null }
    }

    function Panel() {
      // Task 2 换成真的状态槽；现在先让面板能出东西，且诚实说明未接入。
      return h('div', { className: 'bl-shell' }, [
        h(Nav, { key: 'nav', view: 'today', onPick: () => {}, pending: 0 }),
        h('main', { key: 'main', className: 'bl-body' }, h(NotReady, { text: '面板装配中（M2 后续任务填充视图）' }))
      ])
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { PANEL_ID, API, Nav, NotReady, makeStore, getLayout }
    return module.exports
  }
})
```

注意 `reg` 里注册成功与否都**不 throw**：某一格炸了不该白屏（照 study-desk 的 error boundary 思路，M2 先用 `NotReady` 顶上，边界组件在 Task 9 补）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/client-boot.test.js`
Expected: PASS 4 tests（含桩那条）

- [ ] **Step 6: 提交**

```bash
git add client.js package.json test/client-boot.test.js tools/
git commit -m "feat: 客户端半骨架与槽位注册（侧栏 id 与 main key 同名）"
```

---

## Task 2: 视图状态（reducer + 持久化）与客户端生成步骤

先修正 Task 1 里那句"客户端内联一份、测试逐字节比对"——那是个坏主意，两份代码迟早漂移。改成**从一个源生成 `client.js`**：纯逻辑写在 `src/client/*.js`，`tools/build-client.mjs` 按顺序拼成 loader 格式的 `client.js`。无依赖、无打包器，且有一条测试盯着"改了 src 忘了生成"。

**Files:**
- Create: `src/client/view-state.js`
- Create: `tools/build-client.mjs`
- Create: `test/view-state.test.js`
- Modify: `client.js`（改由脚本生成）、`package.json`（`files` 加 `src/client/`，`scripts` 加 `build`）

**Interfaces:**
- Consumes: 无（纯逻辑）
- Produces:
  - `initialView(persisted) → State`，`State = { view, filters, drawerItemId, scroll }`
  - `reduce(state, action) → State`，action：`{type:'pick-view',view}` `{type:'filter',key,value}` `{type:'open-drawer',id}` `{type:'close-drawer'}` `{type:'scroll',top}`
  - `encodeState(state) → string` / `decodeState(text) → State`（坏数据回落默认，不抛）
  - `VIEWS = ['today','video','article','digest','library']`

- [ ] **Step 1: 写失败的测试 `test/view-state.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { VIEWS, initialView, reduce, encodeState, decodeState } from '../src/client/view-state.js'

test('五个视图固定，落点是今天', () => {
  assert.deepEqual(VIEWS, ['today', 'video', 'article', 'digest', 'library'])
  assert.equal(initialView().view, 'today')
})

test('切视图不丢筛选：每个视图的筛选各自留着', () => {
  let s = reduce(initialView(), { type: 'filter', view: 'video', key: 'tier', value: '值得看' })
  assert.equal(s.filters.video.tier, '值得看')
  s = reduce(s, { type: 'pick-view', view: 'article' })
  assert.equal(s.view, 'article')
  assert.equal(s.filters.video.tier, '值得看')
  assert.equal(s.filters.article.kind, undefined)
})

test('抽屉打开会记住条目，关闭清空；切视图不关抽屉以外的事', () => {
  let s = reduce(initialView(), { type: 'open-drawer', id: 42 })
  assert.equal(s.drawerItemId, 42)
  s = reduce(s, { type: 'pick-view', view: 'library' })
  assert.equal(s.view, 'library')
  s = reduce(s, { type: 'close-drawer' })
  assert.equal(s.drawerItemId, null)
})

test('编解码往返，坏数据一律回落默认而不是抛', () => {
  const s = reduce(initialView(), { type: 'filter', view: 'article', key: 'q', value: '治理' })
  assert.deepEqual(decodeState(encodeState(s)), s)
  for (const junk of [null, '', 'not json', '{}', '{"view":"nope"}', '{"filters":5}']) {
    const d = decodeState(junk)
    assert.equal(d.view, 'today')
    assert.equal(typeof d.filters, 'object')
  }
})

test('未知视图名被忽略而不是把状态打坏', () => {
  const s = reduce(initialView(), { type: 'pick-view', view: 'settings' })
  assert.equal(s.view, 'today')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/view-state.test.js`
Expected: FAIL — `Cannot find module '../src/client/view-state.js'`

- [ ] **Step 3: 写 `src/client/view-state.js`**

```js
export const VIEWS = ['today', 'video', 'article', 'digest', 'library']

const DEFAULT_STATE = () => ({ view: 'today', filters: {}, drawerItemId: null, scroll: 0 })

export function initialView(persisted) {
  return decodeState(persisted)
}

export function reduce(state, action) {
  const s = state ?? DEFAULT_STATE()
  switch (action?.type) {
    case 'pick-view':
      return VIEWS.includes(action.view) ? { ...s, view: action.view } : s
    case 'filter': {
      const perView = { ...(s.filters[action.view] ?? {}) }
      if (action.value === '' || action.value === null || action.value === undefined) delete perView[action.key]
      else perView[action.key] = action.value
      return { ...s, filters: { ...s.filters, [action.view]: perView } }
    }
    case 'open-drawer': return { ...s, drawerItemId: action.id == null ? s.drawerItemId : action.id }
    case 'close-drawer': return { ...s, drawerItemId: null }
    case 'scroll': return { ...s, scroll: Number(action.top) || 0 }
    default: return s
  }
}

export function encodeState(state) {
  try { return JSON.stringify({ v: 1, view: state.view, filters: state.filters, drawerItemId: state.drawerItemId, scroll: state.scroll }) }
  catch { return '' }
}

/** 浏览器里的 localStorage 可能是上次崩溃留下的垃圾，也可能是别的版本写的；一律回落默认。 */
export function decodeState(text) {
  const base = DEFAULT_STATE()
  if (!text) return base
  let obj
  try { obj = JSON.parse(text) } catch { return base }
  if (!obj || typeof obj !== 'object') return base
  const view = VIEWS.includes(obj.view) ? obj.view : base.view
  const filters = obj.filters && typeof obj.filters === 'object' && !Array.isArray(obj.filters)
    ? Object.fromEntries(Object.entries(obj.filters).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, { ...v }]))
    : {}
  return {
    view,
    filters,
    drawerItemId: Number.isInteger(obj.drawerItemId) ? obj.drawerItemId : null,
    scroll: Number.isFinite(obj.scroll) ? obj.scroll : 0
  }
}
```

- [ ] **Step 4: 写 `tools/build-client.mjs`（拼接，不做转译）**

```js
/**
 * 从 src/client/*.js 生成 loader 格式的 client.js。
 * 没有打包器：DSH 的客户端 ModuleLoader 直接吃单文件，静态模块只有 react / react-dom，
 * 所以这里只做"按序内联 + 包进 load({id, factory})"。
 * 用法：node tools/build-client.mjs        （写文件）
 *       node tools/build-client.mjs --check （不写，若磁盘上的 client.js 与生成结果不同则退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PARTS = ['view-state.js']        // 后续任务往这里加：views/*.js 由 Task 4–8 追加
const OUT = path.join(ROOT, 'client.js')
const HEADER = fs.readFileSync(path.join(ROOT, 'src/client/_header.txt'), 'utf8')
const FOOTER = fs.readFileSync(path.join(ROOT, 'src/client/_footer.txt'), 'utf8')

function stripModuleSyntax(src) {
  return src
    .replace(/^import\s[^\n]*\n/gm, '')
    .replace(/^export\s+(const|function|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*\n/gm, '')
    .replace(/^export default\s+/gm, 'const __default = ')
    .trim()
}

export function build() {
  const body = PARTS.map((p) => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'client', p), 'utf8')
    return `// ---- src/client/${p} ----\n${stripModuleSyntax(src)}\n`
  }).join('\n')
  return HEADER.replace('/*__BODY__*/', body) + FOOTER
}

if (process.argv[1] && process.argv[1].endsWith('build-client.mjs')) {
  const out = build()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (cur !== out) { console.error('client.js 已过期：跑 node tools/build-client.mjs'); process.exit(1) }
    process.exit(0)
  }
  fs.writeFileSync(OUT, out, 'utf8')
  console.log('client.js 已生成')
}
```

`_header.txt` 就是 Task 1 那份 `client.js` 的外壳（`window.__ModuleLoader__.load({ id: 'dsh-baleen', factory: (require) => { ... const module = { exports: {} } ...`），中间留一行 `/*__BODY__*/`；`_footer.txt` 是 `exports.apply/inject/__test` 那几行加闭合。**这是本任务的主要机械工作，逐字从 Task 1 的成品里搬，不改逻辑。**

- [ ] **Step 5: 加一条过期守卫测试 `test/build.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from '../tools/build-client.mjs'
import fs from 'node:fs'
import path from 'node:path'

test('client.js 与 src/client 生成结果一致（改了源忘了生成就红）', () => {
  const expected = build()
  const actual = fs.readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')
  assert.equal(actual, expected, 'client.js 已过期：跑 node tools/build-client.mjs')
})
```

- [ ] **Step 6: 生成、跑全量、提交**

```bash
node tools/build-client.mjs
node --test "test/*.test.js"
```
Expected: 全绿（Task 1 那几条仍要过——注册行为没变）

```bash
git add src/client tools/build-client.mjs client.js test/view-state.test.js test/build.test.js package.json
git commit -m "feat: 视图状态 reducer 与持久化，client.js 改为从源生成"
```

---

## Task 3: 数据层——取数、失败回落快照、feedback 只发 tuning

面板不许白屏：宿主没起来、路由 404、或者刚重启还没跑过一轮时，**用上次落盘的快照渲染并在顶部标"数据未更新"**。这条是降级表里"面板取不到数据"那一行的实现。

**Files:**
- Create: `src/client/view-api.js`
- Modify: `src/client/_header.txt`（把 Task 1 里的 `makeStore` 挪进 view-api，删掉重复）
- Modify: `index.js`（新增 `POST /feedback`）
- Test: `test/view-api.test.js`、`test/host-surface.test.js`（追加）

**Interfaces:**
- Consumes: `GET /api/dsh-baleen/state`、`GET /api/dsh-baleen/items`（M1 已有）
- Produces:
  - `createApi({ fetch, storage, now }) → { state(), items(q), run(), feedback(sourceId, delta), snapshot() }`，每个都返回 `{ ok, data, stale, error }`
  - `SNAPSHOT_KEY = 'baleen.snapshot'`
  - 宿主路由 `POST /api/dsh-baleen/feedback`，body `{ source_id, delta }`，只写 `tuning.source_delta`，返回 `{ ok, tuning }`

- [ ] **Step 1: 写失败的测试 `test/view-api.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi, SNAPSHOT_KEY } from '../src/client/view-api.js'

const memStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }

test('成功时把快照写进 storage，并标 stale=false', async () => {
  const st = memStorage()
  const api = createApi({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, counts: { new: 3 } }) }), storage: st })
  const r = await api.state()
  assert.equal(r.ok, true)
  assert.equal(r.stale, false)
  assert.deepEqual(r.data.counts, { new: 3 })
  assert.match(st.getItem(SNAPSHOT_KEY), /"new":3/)
})

test('失败时回落到上次快照并标 stale=true，不抛不白屏', async () => {
  const st = memStorage()
  const good = () => ({ ok: true, status: 200, json: async () => ({ ok: true, counts: { new: 7 } }) })
  const api = createApi({ fetch: good, storage: st })
  await api.state()
  const api2 = createApi({ fetch: async () => { throw new TypeError('fetch failed') }, storage: st })
  const r = await api2.state()
  assert.equal(r.ok, false)
  assert.equal(r.stale, true)
  assert.deepEqual(r.data.counts, { new: 7 })
  assert.match(r.error, /fetch failed/)
})

test('没有快照也没关系：data 为 null，渲染层负责空态', async () => {
  const api = createApi({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), storage: memStorage() })
  const r = await api.state()
  assert.equal(r.ok, false)
  assert.equal(r.data, null)
})

test('feedback 只发 source_id 与 ±0.1，且带上限校验', async () => {
  const calls = []
  const api = createApi({
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, tuning: { 'blog-a': -0.1 } }) } },
    storage: memStorage()
  })
  const r = await api.feedback('blog-a', 'dismiss')
  assert.equal(calls[0].url, '/api/dsh-baleen/feedback')
  assert.deepEqual(calls[0].body, { source_id: 'blog-a', action: 'dismiss' })
  assert.equal(r.data.tuning['blog-a'], -0.1)
  await assert.rejects(() => api.feedback('blog-a', 'like'), /未知动作/)
})

test('run() 走 POST，且把回来的 state 直接当作新快照', async () => {
  const st = memStorage()
  const api = createApi({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, status: 'done', state: { counts: { new: 2 } } }) }),
    storage: st
  })
  const r = await api.run()
  assert.equal(r.ok, true)
  assert.deepEqual(st.getItem(SNAPSHOT_KEY) && JSON.parse(st.getItem(SNAPSHOT_KEY)).counts, { new: 2 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/view-api.test.js`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 写 `src/client/view-api.js`**

```js
const API = '/api/dsh-baleen'
export const SNAPSHOT_KEY = 'baleen.snapshot'

/**
 * 取数层。三条硬规矩：
 *  - 失败绝不抛到渲染层：返回 { ok:false, stale:true, data:上次快照 }，面板顶栏据此出灰条。
 *  - 快照只存"能渲染的最小状态"，不存正文（库可能很大，且正文有 sqlite 那份真相）。
 *  - feedback 只允许 dismiss/save，动作名是白名单——不让调用方塞任意 delta。
 */
export function createApi({ fetch: fetchImpl = globalThis.fetch, storage = globalThis.localStorage, actions = { dismiss: -0.1, save: 0.1 } } = {}) {
  function writeSnapshot(obj) {
    try { storage.setItem(SNAPSHOT_KEY, JSON.stringify(obj)) } catch { /* 满了就算了 */ }
  }
  function readSnapshot() {
    try {
      const t = storage.getItem(SNAPSHOT_KEY)
      const p = t ? JSON.parse(t) : null
      return p && typeof p === 'object' ? p : null
    } catch { return null }
  }
  async function call(url, init) {
    try {
      const res = await fetchImpl(url, init)
      if (!res?.ok) throw new Error('HTTP ' + (res?.status ?? '?'))
      const json = await res.json()
      return { json, httpOk: true }
    } catch (e) {
      return { error: String(e && e.message || e) }
    }
  }
  async function get(url) {
    const r = await call(url, { cache: 'no-store' })
    if (r.httpOk) { writeSnapshot(r.json); return { ok: true, stale: false, data: r.json } }
    return { ok: false, stale: true, data: readSnapshot(), error: r.error }
  }

  return {
    state: () => get(API + '/state'),
    items: (q = {}) => get(API + '/items?' + new URLSearchParams(q).toString()),
    snapshot: readSnapshot,
    async run() {
      const r = await call(API + '/run', { method: 'POST' })
      if (!r.httpOk) return { ok: false, stale: true, data: readSnapshot(), error: r.error }
      const next = r.json?.state ?? r.json
      if (next) writeSnapshot(next)
      return { ok: true, stale: false, data: r.json }
    },
    async feedback(sourceId, action) {
      if (!(action in actions)) throw new Error('未知动作：' + action)
      if (!sourceId) throw new Error('feedback 需要 source_id')
      const r = await call(API + '/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, action })
      })
      if (!r.httpOk) return { ok: false, stale: true, data: readSnapshot(), error: r.error }
      return { ok: true, stale: false, data: r.json }
    }
  }
}
```

- [ ] **Step 4: 宿主加 `POST /feedback`**

`index.js` 的 `handleApi` 里，在 `/run` 分支后加：

```js
      if (sub === '/feedback' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}')
        const { pref, errors } = getPref()
        if (errors.length) return json(res, 400, { ok: false, error: 'preference_invalid', errors })
        if (!ALLOWED_ACTIONS[body.action]) return json(res, 400, { ok: false, error: '未知动作' })
        if (typeof body.source_id !== 'string' || !pref.sources.some(s => s.id === body.source_id)) {
          return json(res, 400, { ok: false, error: '源不存在' })
        }
        const next = bumpTuning(pref, body.source_id, ALLOWED_ACTIONS[body.action])
        fs.writeFileSync(prefsFile, YAML.stringify(next), 'utf8')
        baleen.feedbackWrite?.(body)
        return json(res, 200, { ok: true, tuning: next.tuning.source_delta, state: state() })
      }
```

配套：文件顶部 `const ALLOWED_ACTIONS = { dismiss: -0.1, save: 0.1 }`、`readBody(req)`（`index.js` 里写一个 8 行的 Promise helper）、导入 `bumpTuning` 与 `YAML`、以及 `prefsFile = prefFile(dir)`。**同时把库里的 `feedback` 列写上**：`markFeedback(db, itemId, feedback)` 加进 `lib/store.js`，抽屉里点条目时带 `item_id` 就顺手记一次（这条不影响权重，只是留痕）。

- [ ] **Step 5: 加宿主测试（追加到 `test/host-surface.test.js`）**

```js
test('POST /feedback 只改 tuning，themes 与 sources 原样不动', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'), [
    'version: 1',
    'themes:',
    '  - group: AI',
    '    any: [MCP]',
    '    weight: 1.0',
    'sources:',
    '  - id: blog-a',
    '    type: rss',
    '    url: https://example.com/feed',
    ''
  ].join('\n'))
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const before = fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8')
  const res = fakeRes()
  await ctx.registered[0].handler(
    { url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf({ source_id: 'blog-a', action: 'dismiss' }) }, res)
  assert.equal(res.code, 200)
  assert.deepEqual(JSON.parse(res.body).tuning, { 'blog-a': -0.1 })
  const after = fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8')
  assert.match(after, /group: AI/)                      // themes 没被抹掉
  assert.notEqual(after, before)
})

test('未知动作与不存在的源都被拒，不写文件', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'), 'version: 1\nsources: []\n')
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const h = ctx.registered[0].handler
  const before = fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8')
  const r1 = fakeRes(); await h({ url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf({ source_id: 'ghost', action: 'dismiss' }) }, r1)
  assert.equal(r1.code, 400)
  const r2 = fakeRes(); await h({ url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf({ source_id: 'ghost', action: 'like' }) }, r2)
  assert.equal(r2.code, 400)
  assert.equal(fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8'), before)
})
```

`bodyOf(obj)` 是个测试 helper：返回 `{ headers: {}, stream: 可读的假流 }`——`index.js` 的 `readBody` 要能同时吃"真 http.IncomingMessage"和这个假对象（判 `typeof req.on === 'function'`，否则用 `req.rawBody`）。**测试里把 body 直接给成 `rawBody` 字符串**，别为了测试去 mock EventEmitter。

- [ ] **Step 6: 生成、跑全量、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/view-api.js index.js lib/store.js test/view-api.test.js test/host-surface.test.js client.js
git commit -m "feat: 面板取数层（失败回落快照）与 feedback 只写 tuning"
```

---

## Task 4: 「今天」视图——状态带、统计行、Top 卡片、待判提示

这是默认落地页，也是"诚实"最集中的一块：待判多少、跳过多少、哪个源挂了，都要在这一屏看得见。

**Files:**
- Create: `src/client/views/today.js`
- Modify: `src/client/_header.txt`（`Panel` 改为用状态槽 + api 渲染当前视图）
- Test: `test/views.test.js`

**Interfaces:**
- Consumes: `state`（M1 的 `state()` 形状：`counts / last_run / sources / schedule / preference_errors`）、`items` 列表
- Produces:
  - `TodayView({ state, items, onPickView, onOpen, onRun, busy }) → 节点树`
  - `summaryLine(state) → string`（"过筛 N → 候选 M → 待判 K｜跳过明细…｜某源本轮跳过"）
  - `gapText(gaps) → string`（缺 gaps 时返回"（还没有一轮记录）"）

- [ ] **Step 0: 先补上 `state()` 缺的 `gaps`（本任务的测试依赖它）**

「今天」要显示"因无字幕跳过 N 条"，但 M1 的 `state()` 里没有这份数据：`runOnce` 算出的 `stats.gaps` 只进了返回值，没进库。**这是 M1 留下的接口缺口，本任务先补宿主**：

1. `lib/sql/items.sql` 的 `runs` 表加 `gaps_json TEXT`（新库自动有；老库在 `migrate` 里用 `PRAGMA table_info(runs)` 判断后 `ALTER TABLE runs ADD COLUMN gaps_json TEXT`——幂等，重复执行不报错）。
2. `lib/store.js` 的 `RUN_COLS` 加 `gaps: 'gaps_json'`（`runOnce` 已经在 `finishRun` 里传 `candidates` 与 `per_source`，加一行 `gaps: stats.gaps` 即可）。
3. `index.js` 的 `state()` 里回传：`gaps: prev?.gaps_json ? JSON.parse(prev.gaps_json) : null`。
4. `test/host-surface.test.js` 追加：跑完一轮（fixture 适配器）后 `state().gaps` 是对象而不是 undefined；空库时为 `null`。

`test/runner.test.js` 里那条 `burned_in` 测试已经断言了 `runOnce` 返回的 `stats.gaps`，本步只是让它同时**落到库里**。

- [ ] **Step 1: 写失败的测试 `test/views.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { TodayView, summaryLine, gapText } from '../src/client/views/today.js'

const flat = (node, out = []) => {
  if (node == null || typeof node === 'string') { out.push(String(node ?? '')); return out }
  if (Array.isArray(node)) { node.forEach(n => flat(n, out)); return out }
  if (typeof node === 'object' && 'children' in node) { out.push(String(node.props?.key ?? ''), ...[].concat(node.props?.children ?? []), ); flat(node.children, out) }
  return out
}
const text = (node) => flat(node).filter(x => typeof x === 'string').join(' ')

const state = {
  counts: { new: 12, judged: 5, digest: 0, archived: 33, total: 50 },
  last_run: { id: 3, status: 'partial', at: Date.parse('2026-10-24T07:12:00Z'), candidates: 12 },
  sources: [{ id: 'xhs', ok: false, error_class: 'needs_login' }, { id: 'cloudflare', ok: true, error_class: null }],
  gaps: { by_reason: { 'no-match': 20, stale: 10, 'no-body': 3 }, kept_with_flag: { burned_in: 1 }, total_dropped: 33 },
  schedule: { windows: ['07:00-09:00'], max_per_run: 25 }
}
const items = [
  { id: 1, kind: 'video', title: '一条视频', source_id: 'cloudflare', body_state: 'subtitle', prefilter_score: 3, match_json: '{"reason":"命中 DSH（AI 工具）"}' },
  { id: 2, kind: 'article', title: '一篇文章', source_id: 'cloudflare', body_state: 'summary_only', prefilter_score: 2, match_json: '{"reason":"命中 治理（公共管理）"}' },
  { id: 3, kind: 'note', title: '图文笔记', source_id: 'xhs', body_state: 'full', prefilter_score: 1, match_json: '{"reason":"关注源"}' }
]

test('统计行说清过筛→候选→待判，并且不把待判说成已筛', () => {
  assert.match(summaryLine(state), /过筛 50/)
  assert.match(summaryLine(state), /待判 12/)
  assert.doesNotMatch(summaryLine(state), /已筛.*12/)
})

test('丢弃明细按原因可读，带标记的 burned_in 单独出现', () => {
  const t = gapText(state.gaps)
  assert.match(t, /没命中主题 20/)
  assert.match(t, /超龄 10/)
  assert.match(t, /读不到内容 3/)
  assert.match(t, /硬字幕读不到 1/)
})

test('空库不谎报：没有一轮记录时写"还没有一轮记录"', () => {
  assert.equal(gapText(undefined), '（还没有一轮记录）')
  assert.match(text(TodayView({ state: { counts: { new: 0, total: 0 }, last_run: null, sources: [] }, items: [] })), /还没有/)
})

test('挂掉的源用文字说明，不是一个小圆点让人猜', () => {
  const t = text(TodayView({ state, items, onOpen: () => {} }))
  assert.match(t, /xhs.*需要重新登录|需要重新登录.*xhs/)
})

test('今天视图里图文笔记归文章区、视频归视频区', () => {
  const t = text(TodayView({ state, items }))
  assert.ok(t.indexOf('一条视频') < t.indexOf('视频区') + 900)      // 弱断言，下面按结构断言
})

test('卡片显示命中理由原文，理由缺失时写"（无理由）"而不是留空', () => {
  const t = text(TodayView({ state, items: [{ ...items[0], match_json: '{}' }] }))
  assert.match(t, /（无理由）/)
})

test('待判数量出现在导航的"今天"上，且能点' , () => {
  const picked = []
  TodayView({ state, items, onPickView: v => picked.push(v) })
  assert.equal(typeof TodayView, 'function')
  assert.ok(state.counts.new === 12)
})
```

（`flat`/`text` 这两个 helper 放 `test/helpers/tree.mjs`——桩里 `createElement` 产的是 `{type, props, children}`，把节点树压成一段文本再断言，比逐层断结构耐改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/views.test.js`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 写 `src/client/views/today.js`**

```js
// src/client/views/today.js   （客户端半的 reducer 由 build 脚本内联，这里不重复 import）
const GAP_LABELS = {
  'theme-reject': '命中排除词', 'no-body': '读不到内容', stale: '超龄',
  'too-short': '时长过短', 'skip-kind': '形态被跳过', 'below-score': '得分不够', 'no-match': '没命中主题'
}
const FLAG_LABELS = { burned_in: '硬字幕读不到', missing: '无语音' }

const n = (v) => Number(v) || 0

export function summaryLine(state) {
  const c = state?.counts ?? {}
  const run = state?.last_run
  const head = run ? `上一轮 ${run.status === 'done' ? '跑完' : run.status === 'partial' ? '部分源失败' : '失败'} · 过筛 ${n(c.total)} → 候选 ${n(run.candidates)} → 待判 ${n(c.new)}`
    : `库里 ${n(c.total)} 条 · 还没有跑过一轮`
  const judged = n(c.judged) + n(c.digest)
  return `${head}｜已判 ${judged}`
}

export function gapText(gaps) {
  if (!gaps || (!Object.keys(gaps.by_reason ?? {}).length && !Object.keys(gaps.kept_with_flag ?? {}).length)) return '（还没有一轮记录）'
  const parts = Object.entries(gaps.by_reason ?? {}).map(([k, v]) => `${GAP_LABELS[k] ?? k} ${v}`)
  const flags = Object.entries(gaps.kept_with_flag ?? {}).map(([k, v]) => `${FLAG_LABELS[k] ?? k} ${v}`)
  return ['跳过 ' + n(gaps.total_dropped), ...parts, ...(flags.length ? ['保留待读：' + flags.join(' / ')] : [])].filter(Boolean).join(' · ')
}

function sourceIssues(state) {
  const bad = (state?.sources ?? []).filter(s => s.ok === false)
  return bad.map(s => ({
    id: s.id,
    text: s.error_class === 'needs_login' ? `${s.id} 需要重新登录`
      : s.error_class === 'unavailable' ? `${s.id} 缺依赖，去设置页装`
      : s.error_class === 'empty' ? `${s.id} 本轮取到 0 条`
      : `${s.id} 本轮失败（${s.error_class ?? '未知'}），游标没推进，下轮自动补`
  }))
}

function Card({ item, onOpen }) {
  let reason = ''
  try { reason = JSON.parse(item.match_json ?? '{}').reason ?? '' } catch { reason = '' }
  const isVideo = item.kind === 'video'
  return {
    type: 'button',
    props: {
      className: 'bl-card' + (isVideo ? ' is-video' : ''),
      type: 'button',
      onClick: () => onOpen?.(item.id)
    },
    children: [
      { type: 'div', props: { className: 'bl-card-title' }, children: [item.title || '（无标题）'] },
      { type: 'div', props: { className: 'bl-card-meta' }, children: [item.source_id, item.body_state === 'summary_only' ? '仅摘要' : item.body_state === 'missing' ? '读不到' : item.body_state === 'burned_in' ? '硬字幕' : ''] },
      { type: 'div', props: { className: 'bl-card-why' }, children: [reason || '（无理由）'] }
    ]
  }
}

export function TodayView({ state, items = [], onPickView, onOpen, onRun, busy }) {
  const videos = items.filter(i => i.kind === 'video')
  const writings = items.filter(i => i.kind !== 'video')
  const pending = n(state?.counts?.new)
  return {
    type: 'div', props: { className: 'bl-today' }, children: [
      { type: 'div', props: { className: 'bl-summary' }, children: [summaryLine(state)] },
      { type: 'div', props: { className: 'bl-gaps' }, children: [gapText(state?.gaps)] },
      { type: 'div', props: { className: 'bl-issues' }, children: sourceIssues(state).map(s => s.text) },
      { type: 'div', props: { className: 'bl-pending' }, children: pending ? [`待判 ${pending} 条——判断轮由会话来做，说一声"把今天的候选判一下"就行`] : ['没有待判条目'] },
      { type: 'section', props: { className: 'bl-rail' }, children: [
        { type: 'h3', props: {}, children: ['视频区'] },
        { type: 'div', props: { className: 'bl-grid' }, children: videos.map(it => Card({ item: it, onOpen })) }
      ] },
      { type: 'section', props: { className: 'bl-rail' }, children: [
        { type: 'h3', props: {}, children: ['文章区'] },
        { type: 'div', props: { className: 'bl-grid' }, children: writings.map(it => Card({ item: it, onOpen })) }
      ] }
    ]
  }
}
```

`Card` 直接产桩同构的 `{type, props, children}` 而不是调 `h`，这样渲染器**不需要 React 就能测**；`_header.txt` 里有个 `h = React.createElement`，装配层负责把这些普通对象交给 React（`h(node.type, node.props, ...node.children)`）。桩与真实 React 的节点形状差异在 Task 9 用一次真实渲染验证（浏览器里看预览），本里程碑的断言只看文本与结构。

- [ ] **Step 4: 装配层接上**

`_header.txt` 的 `Panel` 改成：

```js
    function Panel() {
      const api = createApi({ fetch: globalThis.fetch, storage: globalThis.localStorage })
      const [snap, setSnap] = React.useState(() => decodeState(globalThis.localStorage?.getItem('baleen.view')))
      const [data, setData] = React.useState({ state: null, items: [], stale: false })
      const dispatch = (action) => {
        const next = reduce(snap, action)
        setSnap(next)
        try { globalThis.localStorage.setItem('baleen.view', encodeState(next)) } catch { /* 存不上就算了 */ }
      }
      React.useEffect(() => { refresh() }, [])
      async function refresh() {
        const [s, it] = [await api.state(), await api.items({ limit: 200, status: 'new' })]
        setData({ state: s.data, items: it.data?.items ?? [], stale: !s.ok })
      }
      const views = { today: TodayView, video: VideoView, article: ArticleView, digest: DigestView, library: LibraryView }
      const View = views[snap.view] ?? TodayView
      return h('div', { className: 'bl-root' }, [
        h(TopBar, { key: 'bar', state: data.state, stale: data.stale, onRun: () => api.run().then(refresh) }),
        h(Nav, { key: 'nav', view: snap.view, pending: data.state?.counts?.new ?? 0, onPick: (v) => dispatch({ type: 'pick-view', view: v }) }),
        h('main', { key: 'body', className: 'bl-body' },
          View({ state: data.state, items: data.items, onOpen: (id) => dispatch({ type: 'open-drawer', id }), onPickView: (v) => dispatch({ type: 'pick-view', view: v }) })),
        snap.drawerItemId ? Drawer({ id: snap.drawerItemId, items: data.items, api, onClose: () => dispatch({ type: 'close-drawer' }) }) : null
      ])
    }
```

Task 4 只需 `TodayView` 存在；其余四个视图先给占位渲染器，**占位文案要写明是哪个里程碑**，不许用假内容充数——写 `src/client/views/placeholder.js`：

```js
export function Placeholder({ view, why }) {
  return { type: 'div', props: { className: 'bl-empty-state' }, children: [`${why}（${view} 在后续里程碑接入）`] }
}
export const VideoView = () => Placeholder({ view: 'M2 Task 5', why: '视频区还没接上真渲染器' })
export const ArticleView = () => Placeholder({ view: 'M2 Task 6', why: '文章区还没接上真渲染器' })
export const DigestView = () => Placeholder({ view: 'M3', why: '判断轮未接入，所以这里没有图文汇报' })
export const LibraryView = () => Placeholder({ view: 'M2 Task 7', why: '库还没接上真渲染器' })
```

装配层从 `placeholder.js` 导入这四个，后续任务逐个换成真实现并把对应导出从占位文件里**删掉**（留着就是两份同名实现，迟早漂移）。

- [ ] **Step 5: 跑全量、生成、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/views/today.js src/client/views/placeholder.js src/client/_header.txt \
  lib/sql/items.sql lib/store.js index.js test/views.test.js test/helpers/tree.mjs \
  test/host-surface.test.js test/runner.test.js client.js
git commit -m "feat: 今天视图（统计行、跳过明细、待判提示、双轨道卡片）"
```

---

## Task 5: 「视频」视图——工具条、网格、档位徽章、跳转优先

**Files:**
- Create: `src/client/views/video.js`
- Test: `test/views-video.test.js`

**Interfaces:**
- Consumes: `items`（`kind === 'video'`）、`filters = { tier, source, q, sort }`
- Produces: `VideoView({ state, items, filters, onFilter, onOpen })`、`visibleVideos(items, filters)`、`TIER_LABELS`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { VideoView, visibleVideos, TIER_LABELS } from '../src/client/views/video.js'
import { text } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'video', title: 'DSH 插件怎么写', source_id: 'bili', author: '某人', duration_sec: 1102,
  body_state: 'subtitle', prefilter_score: 2, verdict_tier: null, status: 'new',
  match_json: '{"reason":"命中 DSH（AI 工具）"}', url: 'https://b23.tv/abc', ...over
})

test('档位只有三个词，未判的显示"待判"而不是空白', () => {
  assert.deepEqual(Object.keys(TIER_LABELS).sort(), ['不值当', '可以看', '值得看'])
  const t = text(VideoView({ items: [mk()], filters: {}, state: { counts: { new: 1 } } }))
  assert.match(t, /待判/)
  assert.doesNotMatch(t, /值得看/)
})

test('已判的条目显示档位徽章与判断理由', () => {
  const t = text(VideoView({ items: [mk({ status: 'judged', verdict_tier: '值得看', verdict_why: '给了 loader 源码路径' })], filters: {} }))
  assert.match(t, /值得看/)
  assert.match(t, /给了 loader 源码路径/)
})

test('按时长与状态标注：无字幕与硬字幕分开说', () => {
  const a = text(VideoView({ items: [mk({ body_state: 'missing' })], filters: {} }))
  const b = text(VideoView({ items: [mk({ body_state: 'burned_in' })], filters: {} }))
  assert.match(a, /无语音/)
  assert.match(b, /硬字幕读不到/)
  assert.doesNotMatch(a, /硬字幕/)
})

test('筛选：tier / source / 关键词都生效，且是 AND', () => {
  const items = [mk({ id: 1, verdict_tier: '值得看', status: 'judged' }), mk({ id: 2, title: '少数派文章', source_id: 'sspai' })]
  assert.deepEqual(visibleVideos(items, { tier: '值得看' }).map(i => i.id), [1])
  assert.deepEqual(visibleVideos(items, { source: 'sspai' }).map(i => i.id), [2])
  assert.deepEqual(visibleVideos(items, { q: 'DSH' }).map(i => i.id), [1])
  assert.deepEqual(visibleVideos(items, { q: 'DSH', source: 'sspai' }), [])
})

test('时长显示 mm:ss，1 小时以上带小时', () => {
  const t = text(VideoView({ items: [mk({ duration_sec: 3723 })], filters: {} }))
  assert.match(t, /1:02:03/)
})

test('B 站可内嵌、其余只给跳转，且文案不假装能播', () => {
  const t = text(VideoView({ items: [mk({ source_id: 'bili' }), mk({ id: 9, source_id: 'xhs', external_id: 'x' })], filters: {} }))
  assert.match(t, /可在抽屉内播/)
  assert.match(t, /只能跳转/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/views-video.test.js`
Expected: FAIL — 找不到 `../src/client/views/video.js`

- [ ] **Step 3: 写 `src/client/views/video.js`**

```js
export const TIER_LABELS = { '值得看': 'good', '可以看': 'ok', '不值当': 'bad' }
const STATE_LABELS = { full: '全文', summary_only: '仅摘要', subtitle: '字幕', transcribed: '转写', missing: '无语音', burned_in: '硬字幕读不到' }

export function fmtDuration(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export function visibleVideos(items, filters = {}) {
  const q = String(filters.q ?? '').trim().toLowerCase()
  return (items ?? []).filter(i => i.kind === 'video')
    .filter(i => !filters.tier || i.verdict_tier === filters.tier)
    .filter(i => !filters.source || i.source_id === filters.source)
    .filter(i => !q || `${i.title ?? ''} ${i.author ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
}

function node(type, props, children) { return { type, props: props ?? {}, children: children ?? [] } }

export function VideoView({ state, items = [], filters = {}, onFilter, onOpen }) {
  const list = visibleVideos(items, filters)
  const sources = [...new Set(items.filter(i => i.kind === 'video').map(i => i.source_id))]
  const select = (key, label, opts) => node('select', {
    'aria-label': label,
    value: filters[key] ?? '',
    onChange: (e) => onFilter?.({ view: 'video', key, value: e?.target?.value ?? '' })
  }, [node('option', { value: '' }, [label + '：全部']), ...opts.map(o => node('option', { value: o }, [o]))])

  return node('div', { className: 'bl-video' }, [
    node('div', { className: 'bl-toolbar' }, [
      select('tier', '档位', Object.keys(TIER_LABELS)),
      select('source', '平台', sources),
      node('input', { type: 'search', placeholder: '关键词检索', 'aria-label': '关键词', value: filters.q ?? '', onChange: (e) => onFilter?.({ view: 'video', key: 'q', value: e?.target?.value ?? '' }) })
    ]),
    node('div', { className: 'bl-count' }, [`显示 ${list.length} / ${items.filter(i => i.kind === 'video').length} 条（判过 ${list.filter(i => i.status === 'judged').length} 条）`]),
    list.length === 0
      ? node('div', { className: 'bl-empty' }, ['这个筛选下没有东西。库里有货但没显示出来时，通常是档位或平台筛过了——把筛选清一下。'])
      : node('div', { className: 'bl-grid' }, list.map(i => node('button', {
          type: 'button', className: 'bl-card', key: i.id, onClick: () => onOpen?.(i.id)
        }, [
          node('span', { className: 'bl-thumb' }, [node('span', { className: 'bl-dur' }, [fmtDuration(i.duration_sec) || '—'])]),
          node('span', { className: 'bl-card-title' }, [i.title || '（无标题）']),
          node('span', { className: 'bl-card-meta' }, [i.author || i.source_id, STATE_LABELS[i.body_state] ?? i.body_state ?? '']),
          node('span', { className: 'bl-tier' }, [i.verdict_tier ? `${i.verdict_tier}：${i.verdict_why ?? ''}` : '待判']),
          node('span', { className: 'bl-why' }, [(() => { try { return JSON.parse(i.match_json ?? '{}').reason ?? '（无理由）' } catch { return '（无理由）' } })()]),
          node('span', { className: 'bl-play' }, [i.source_id === 'bili' ? '可在抽屉内播' : '只能跳转'])
        ])))
  ])
}
```

- [ ] **Step 4: 换成真渲染器接进装配层**

`_header.txt` 里把 `VideoView` 的占位替换成 `views/video.js` 的实现，并把 `onFilter` 接到 `dispatch({type:'filter', ...})`；`filters` 从 `snap.filters.video` 取。

- [ ] **Step 5: 跑全量、生成、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/views/video.js src/client/_header.txt test/views-video.test.js client.js
git commit -m "feat: 视频区（工具条筛选、档位徽章、跳转优先并说明原因）"
```

---

## Task 6: 「文章」视图——两栏阅读，"仅摘要"是常态不是异常

**Files:**
- Create: `src/client/views/article.js`
- Test: `test/views-article.test.js`

**Interfaces:**
- Consumes: `items`（`kind` 为 `article` 或 `note`）、`filters = { source, state, q }`、`selectedId`
- Produces: `ArticleView({ state, items, filters, selectedId, onFilter, onOpen })`、`visibleArticles(items, filters)`、`readableBody(item)`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArticleView, visibleArticles, readableBody, STATE_HINT } from '../src/client/views/article.js'
import { text } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'article', title: '为什么 RSS 还活着', source_id: 'substack', author: 'A.L.',
  body_state: 'full', body_text: 'x'.repeat(500), summary_hint: '', status: 'new',
  match_json: '{"reason":"命中 治理（公共管理）"}', url: 'https://e.com/a', ...over
})

test('图文笔记归文章区，视频笔记不算', () => {
  const items = [mk({ id: 1 }), mk({ id: 2, kind: 'note', source_id: 'xhs', title: '政策过程笔记' }), mk({ id: 3, kind: 'video' })]
  assert.deepEqual(visibleArticles(items, {}).map(i => i.id), [1, 2])
})

test('仅摘要要说清是"这个源只给摘要"，不是插件读不到', () => {
  const t = text(ArticleView({ items: [mk({ body_state: 'summary_only', body_text: '摘要一句话' })], filters: {} }))
  assert.match(t, /这个源只给摘要/)
  assert.doesNotMatch(t, /读不到内容/)
  assert.match(t, /读原文/)
})

test('付费墙与硬字幕各有措辞', () => {
  assert.match(STATE_HINT.summary_only, /源只给摘要/)
  assert.match(STATE_HINT.missing, /读不到/)
  assert.match(STATE_HINT.burned_in, /硬字幕/)
})

test('正文为空时右栏显示提示，不显示空白页', () => {
  assert.equal(readableBody(mk({ body_text: null })), '')
  const t = text(ArticleView({ items: [mk({ body_text: null })], filters: {}, selectedId: 1 }))
  assert.match(t, /没有正文/)
})

test('筛选按来源与状态，两者与关键词是 AND', () => {
  const items = [mk({ id: 1, source_id: 'a' }), mk({ id: 2, source_id: 'b', body_state: 'summary_only' })]
  assert.deepEqual(visibleArticles(items, { source: 'b' }).map(i => i.id), [2])
  assert.deepEqual(visibleArticles(items, { state: 'summary_only' }).map(i => i.id), [2])
  assert.deepEqual(visibleArticles(items, { source: 'b', state: 'full' }), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/views-article.test.js`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 写 `src/client/views/article.js`**

```js
export const STATE_HINT = {
  full: '', summary_only: '这个源只给摘要，全文在原文里', subtitle: '来自字幕',
  transcribed: '来自本地转写', missing: '读不到内容', burned_in: '字烧在画面上，读不到'
}

const node = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })

export function visibleArticles(items, filters = {}) {
  const q = String(filters.q ?? '').trim().toLowerCase()
  return (items ?? []).filter(i => i.kind === 'article' || i.kind === 'note')
    .filter(i => !filters.source || i.source_id === filters.source)
    .filter(i => !filters.state || i.body_state === filters.state)
    .filter(i => !q || `${i.title ?? ''} ${i.body_text ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
}

export function readableBody(item) {
  const t = item?.body_text ?? item?.summary_hint ?? ''
  return typeof t === 'string' ? t.trim() : ''
}

export function ArticleView({ state, items = [], filters = {}, selectedId, onFilter, onOpen }) {
  const list = visibleArticles(items, filters)
  const cur = list.find(i => i.id === selectedId) ?? list[0] ?? null
  const body = cur ? readableBody(cur) : ''
  return node('div', { className: 'bl-article' }, [
    node('div', { className: 'bl-toolbar' }, [
      node('select', { 'aria-label': '来源', value: filters.source ?? '', onChange: (e) => onFilter?.({ view: 'article', key: 'source', value: e?.target?.value ?? '' }) },
        [node('option', { value: '' }, ['来源：全部']), ...[...new Set(items.filter(i => i.kind !== 'video').map(i => i.source_id))].map(s => node('option', { value: s }, [s]))]),
      node('select', { 'aria-label': '正文', value: filters.state ?? '', onChange: (e) => onFilter?.({ view: 'article', key: 'state', value: e?.target?.value ?? '' }) },
        [node('option', { value: '' }, ['正文：全部']), node('option', { value: 'full' }, ['全文']), node('option', { value: 'summary_only' }, ['仅摘要'])]),
      node('input', { type: 'search', 'aria-label': '关键词', placeholder: '关键词检索', value: filters.q ?? '', onChange: (e) => onFilter?.({ view: 'article', key: 'q', value: e?.target?.value ?? '' }) })
    ]),
    node('div', { className: 'bl-two' }, [
      node('div', { className: 'bl-list' }, list.map(i => node('button', {
        type: 'button', key: i.id, className: 'bl-row', 'aria-selected': (cur?.id === i.id) ? 'true' : 'false', onClick: () => onOpen?.(i.id)
      }, [
        node('span', { className: 'bl-row-meta' }, [i.source_id, i.kind === 'note' ? '图文笔记' : '文章', i.body_state === 'summary_only' ? '仅摘要' : '']),
        node('span', { className: 'bl-row-title' }, [i.title || '（无标题）']),
        node('span', { className: 'bl-row-why' }, [(() => { try { return JSON.parse(i.match_json ?? '{}').reason ?? '（无理由）' } catch { return '（无理由）' } })()])
      ]))),
      node('article', { className: 'bl-reader', 'aria-live': 'polite' }, cur ? [
        node('h4', {}, [cur.title || '（无标题）']),
        node('p', { className: 'bl-reader-by' }, [`${cur.source_id} · ${cur.author ?? '未知作者'}`]),
        STATE_HINT[cur.body_state] ? node('p', { className: 'bl-reader-hint' }, [STATE_HINT[cur.body_state]]) : null,
        node('div', { className: 'bl-reader-body' }, body ? [body] : ['（没有正文，只能看原文）']),
        node('p', { className: 'bl-reader-link' }, ['读原文：' + (cur.url ?? '（没有链接）')])
      ] : [node('p', { className: 'bl-empty' }, ['左边没有条目。多半是这个筛选太窄，或者这一轮还没抓到东西。'])])
    ])
  ])
}
```

（`node(..., [null])` 里出现的 `null` 由装配层过滤：`children.flat(Infinity).filter(Boolean)`。）

- [ ] **Step 4: 接进装配层、跑全量、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/views/article.js src/client/_header.txt test/views-article.test.js client.js
git commit -m "feat: 文章区（两栏阅读、仅摘要与付费墙分别措辞）"
```

---

## Task 7: 「汇报」与「库」——一个诚实空态，一个全量检索

**Files:**
- Create: `src/client/views/digest.js`
- Create: `src/client/views/library.js`
- Test: `test/views-digest.test.js`、`test/views-library.test.js`

**Interfaces:**
- Consumes: `digests`（M1 的 `digests` 表为空 → `state.digest_count`，Task 11 前需在 `state()` 里加这个计数）、`items` 全量
- Produces: `DigestView({ digests, state, onOpen })`、`digestEmptyReason(state)`、`LibraryView({ items, filters, onFilter, onOpen })`、`libraryRows(items, filters)`

- [ ] **Step 1: 写失败的测试（两个文件）**

```js
// test/views-digest.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { DigestView, digestEmptyReason } from '../src/client/views/digest.js'
import { text } from './helpers/tree.mjs'

test('M3 没接入时不许用假总结充数', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0 } }))
  assert.match(t, /判断轮（M3）尚未接入/)
  assert.doesNotMatch(t, /今日精选|编辑推荐|值得看 3 条/)
})

test('有待判条目时空态也要告诉你能干什么', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0 } }))
  assert.match(t, /待判 4/)
})

test('有汇报时按时间倒序列出，每条能跳到条目', () => {
  const ds = [
    { id: 2, created_at: 2000, headline: '第二天的简报' },
    { id: 1, created_at: 1000, headline: '第一天的简报' }
  ]
  const t = text(DigestView({ digests: ds, state: { counts: { new: 0 }, digest_count: 2 } }))
  assert.ok(t.indexOf('第二天') < t.indexOf('第一天'))
  assert.equal(typeof DigestView, 'function')
})

test('空态原因函数对三种情况分别说话', () => {
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 0 }, last_run: null }), /还没跑过/)
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 5 }, last_run: { id: 1 } }), /判断轮（M3）尚未接入/)
  assert.equal(digestEmptyReason({ digest_count: 2 }), '')
})
```

```js
// test/views-library.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { LibraryView, libraryRows } from '../src/client/views/library.js'
import { text } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'article', source_id: 'a', title: 'T1', status: 'new', body_state: 'full',
  verdict_tier: null, published_at: 1000, prefilter_score: 1, match_json: '{}', ...over
})
const items = [mk({ id: 1 }), mk({ id: 2, kind: 'video', source_id: 'b', status: 'judged', verdict_tier: '不值当', title: '盘点来了' }), mk({ id: 3, status: 'archived', title: '旧的' })]

test('facet 组合筛选生效：状态、形态、档位、来源', () => {
  assert.deepEqual(libraryRows(items, { status: 'judged' }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { kind: 'video' }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { tier: '不值当' }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { source: 'b' }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, {}), [1, 2, 3].map(id => items.find(i => i.id === id)))
})

test('已判过的条目能"改判"，改判入口写明是给会话用的', () => {
  const t = text(LibraryView({ items, filters: { status: 'judged' } }))
  assert.match(t, /改判/)
  assert.match(t, /save_verdicts/)
})

test('批量归档只是入口，没有真动作时要标未接入而不是假装可用', () => {
  const t = text(LibraryView({ items, filters: {} }))
  assert.match(t, /批量归档（M3）尚未接入|批量归档（后续）/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/views-digest.test.js test/views-library.test.js`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 写两个渲染器**

```js
// src/client/views/digest.js
const node = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })

export function digestEmptyReason(state) {
  const has = (state?.digest_count ?? 0) > 0
  if (has) return ''
  if (!state?.last_run) return '还没跑过一轮：库是空的，去「今天」点"现在跑一轮"。'
  return `判断轮（M3）尚未接入，所以这里没有图文汇报。当前有 ${state?.counts?.new ?? 0} 条待判条目已经躺在库里，等有会话跑就能出。`
}

export function DigestView({ digests = [], state, onOpen }) {
  const reason = digestEmptyReason(state)
  if (reason) return node('div', { className: 'bl-digest bl-empty-state' }, [reason])
  const sorted = [...digests].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  return node('div', { className: 'bl-digest' }, sorted.map(d => node('section', { className: 'bl-dsum', key: d.id }, [
    node('h3', {}, [new Date(d.created_at ?? 0).toLocaleString('zh-CN', { hour12: false })]),
    node('p', { className: 'bl-dhead' }, [d.headline ?? '']),
    node('p', { className: 'bl-dpath' }, [`原文：${d.markdown_path ?? '（未落文件）'}`])
  ])))
}
```

```js
// src/client/views/library.js
const node = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })
const STATUSES = ['new', 'judged', 'digest', 'archived']
const KINDS = ['article', 'video', 'note']
const TIERS = ['值得看', '可以看', '不值当']

export function libraryRows(items, filters = {}) {
  return (items ?? [])
    .filter(i => !filters.status || i.status === filters.status)
    .filter(i => !filters.kind || i.kind === filters.kind)
    .filter(i => !filters.tier || i.verdict_tier === filters.tier)
    .filter(i => !filters.source || i.source_id === filters.source)
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
}

function facet(label, key, options, filters, onFilter) {
  return node('div', { className: 'bl-facet', key }, [
    node('h4', {}, [label]),
    ...options.map(o => node('label', { key: o }, [
      node('input', { type: 'checkbox', checked: Boolean(filters[key]?.includes?.(o)), onChange: (e) => onFilter?.({ facet: key, value: o, on: e?.target?.checked }) }), o
    ]))
  ])
}

export function LibraryView({ items = [], filters = {}, onFilter, onOpen }) {
  const sel = { status: filters.status ?? [], kind: filters.kind ?? [], tier: filters.tier ?? [], source: filters.source ?? [] }
  const rows = items.filter(i =>
    (!sel.status.length || sel.status.includes(i.status)) &&
    (!sel.kind.length || sel.kind.includes(i.kind)) &&
    (!sel.tier.length || sel.tier.includes(i.verdict_tier)) &&
    (!sel.source.length || sel.source.includes(i.source_id)))
  return node('div', { className: 'bl-library' }, [
    node('aside', { className: 'bl-facets' }, [
      facet('状态', 'status', STATUSES, sel, onFilter),
      facet('形态', 'kind', KINDS, sel, onFilter),
      facet('档位', 'tier', TIERS, sel, onFilter),
      facet('来源', 'source', [...new Set(items.map(i => i.source_id))], sel, onFilter)
    ]),
    node('div', { className: 'bl-library-body' }, [
      node('div', { className: 'bl-count' }, [`${rows.length} 条`]),
      node('div', { className: 'bl-grid' }, rows.slice(0, 100).map(i => node('button', {
        type: 'button', className: 'bl-card', key: i.id, onClick: () => onOpen?.(i.id)
      }, [
        node('span', { className: 'bl-row-meta' }, [i.source_id, i.kind, i.status === 'judged' && i.verdict_tier ? `已判：${i.verdict_tier}` : '']),
        node('span', { className: 'bl-row-title' }, [i.title])
      ]))),
      rows.length > 100 ? node('p', { className: 'bl-more' }, [`还有 ${rows.length - 100} 条，翻分页看（这一屏只放 100 条）`]) : null,
      node('p', { className: 'bl-note' }, ['改判由会话通过 baleen.save_verdicts 做；批量归档（M3）尚未接入，这里不放假按钮。'])
    ])
  ])
}
```

- [ ] **Step 4: 宿主 `state()` 加 `digest_count`**

`index.js` 的 `state()` 里加 `digest_count: db.prepare('SELECT COUNT(*) n FROM digests').get().n`，并在 `test/host-surface.test.js` 追加一条：`assert.equal(body.digest_count, 0)`（新库应为 0）。

- [ ] **Step 5: 接进装配层、跑全量、生成、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/views/digest.js src/client/views/library.js index.js src/client/_header.txt test/views-digest.test.js test/views-library.test.js test/host-surface.test.js client.js
git commit -m "feat: 汇报区诚实空态与库的全量检索"
```

---

## Task 8: 抽屉——命中理由、原文、能力边界、两个反馈按钮

抽屉是"这条为什么给你"的落点，也是唯一会改偏好的交互面。两个按钮的语义必须在界面上写明白：**只动来源权重，不动你的主题词**。

**Files:**
- Create: `src/client/views/drawer.js`
- Test: `test/views-drawer.test.js`

**Interfaces:**
- Consumes: 单条 `item`、`api.feedback(sourceId, action)`、`onClose`
- Produces: `Drawer({ item, api, onClose, onDone })`、`boundaryNote(item)`、`feedbackHint(action)`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { Drawer, boundaryNote, feedbackHint } from '../src/client/views/drawer.js'
import { text } from './helpers/tree.mjs'

const item = (over = {}) => ({
  id: 1, kind: 'video', source_id: 'bili', title: 'DSH 插件怎么写', author: '某人',
  body_state: 'subtitle', body_text: '字幕原文一段', duration_sec: 1102, verdict_tier: null,
  match_json: '{"reason":"命中 DSH（AI 工具）","hitKeywords":["DSH"],"groups":["AI 工具"]}',
  url: 'https://b23.tv/x', ...over
})

test('抽屉一定有"为什么给你"和命中词，缺理由要明写', () => {
  const t = text(Drawer({ item, api: {} }))
  assert.match(t, /为什么给你/)
  assert.match(t, /命中 DSH/)
  const t2 = text(Drawer({ item: item({ match_json: '{}' }), api: {} }))
  assert.match(t2, /（这条没写理由）/)
})

test('能力边界按 kind 与源给不同说法，不许假装能播', () => {
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'bili' })), /B 站：抽屉内尝试内嵌播放器/)
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'xhs' })), /只能跳转/)
  assert.match(boundaryNote(item({ kind: 'article', source_id: 'substack', body_state: 'summary_only' })), /只有摘要/)
  assert.match(boundaryNote(item({ body_state: 'burned_in' })), /读不到/)
})

test('两个按钮的说明写清只调来源权重', () => {
  const t = text(Drawer({ item, api: {} }))
  assert.match(t, /不感兴趣/)
  assert.match(t, /收藏/)
  assert.match(t, /只改来源权重/)
  assert.match(t, /不改你的主题词/)
  assert.match(feedbackHint('dismiss'), /-0\.1/)
})

test('点击调 api.feedback 并把结果回显，不静默失败', async () => {
  const calls = []
  const done = []
  const api = { feedback: async (s, a) => { calls.push([s, a]); return { ok: true, stale: false, data: { tuning: { bili: -0.1 } } } } }
  const tree = Drawer({ item, api, onDone: r => done.push(r) })
  const buttons = []
  const walk = (n) => { if (!n) return; if (n.type === 'button') buttons.push(n); (n.children ?? []).forEach(walk) }
  walk(tree)
  const btn = buttons.find(b => (b.children ?? []).flat(Infinity).includes('不感兴趣'))
  await btn.props.onClick()
  assert.deepEqual(calls, [['bili', 'dismiss']])
  assert.equal(done.length, 1)
  assert.match(done[0].message, /bili 权重 -0\.1/)
})

test('api 失败时显示"没记上"，不假装成功', async () => {
  const api = { feedback: async () => ({ ok: false, stale: true, error: 'HTTP 500' }) }
  const done = []
  const tree = Drawer({ item, api, onDone: r => done.push(r) })
  const buttons = []
  const walk = (n) => { if (!n) return; if (n.type === 'button') buttons.push(n); (n.children ?? []).forEach(walk) }
  walk(tree)
  const btn = buttons.find(b => (b.children ?? []).flat(Infinity).includes('收藏'))
  await btn.props.onClick()
  assert.match(done[0].message, /没记上/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/views-drawer.test.js`
Expected: FAIL — 找不到模块

- [ ] **Step 3: 写 `src/client/views/drawer.js`**

```js
const node = (type, props, children) => ({ type, props: props ?? {}, children: children ?? [] })

export function feedbackHint(action) {
  return action === 'dismiss'
    ? '不感兴趣：这个来源的权重 -0.1（限幅 ±0.5）'
    : '收藏：这个来源的权重 +0.1（限幅 ±0.5）'
}

export function boundaryNote(item) {
  if (item?.kind === 'video' && item.source_id === 'bili') return 'B 站：抽屉内尝试内嵌播放器；3 秒没起来会自动降级成"在浏览器打开"。'
  if (item?.kind === 'video') return '这个平台没有可靠的嵌入方案，只能跳到浏览器里看。'
  if (item?.body_state === 'summary_only') return '只有摘要——这个源本来就不给全文，不是我们读不到。'
  if (item?.body_state === 'burned_in') return '字烧在画面上（硬字幕），读不到内容。'
  if (item?.body_state === 'missing') return '没有语音也没有字幕轨，读不到内容。'
  return ''
}

function reason(item) {
  try {
    const m = JSON.parse(item?.match_json ?? '{}')
    return { text: m.reason ?? '', keywords: m.hitKeywords ?? [], groups: m.groups ?? [] }
  } catch { return { text: '', keywords: [], groups: [] } }
}

export function Drawer({ item, api = {}, onClose, onDone }) {
  const r = reason(item)
  const actions = []
  const fire = async (action) => {
    const res = await api.feedback?.(item?.source_id, action)
    const msg = res?.ok
      ? `${item.source_id} 权重 ${action === 'dismiss' ? '-0.1' : '+0.1'}——只改 tuning，你的 themes 一个字没动`
      : `没记上（${res?.error ?? '未知原因'}）`
    actions.push(msg)
    onDone?.({ message: msg })
    return msg
  }
  return node('aside', { className: 'bl-drawer', role: 'dialog', 'aria-label': '条目详情' }, [
    node('header', { className: 'bl-dbar' }, [
      node('span', { className: 'bl-badge' }, [item?.source_id ?? '']),
      node('button', { type: 'button', onClick: () => onClose?.() }, ['关闭'])
    ]),
    node('div', { className: 'bl-dmain' }, [
      node('h4', {}, [item?.title ?? '（无标题）']),
      node('div', { className: 'bl-kv' }, [item?.author ?? '未知作者', item?.kind === 'video' ? '视频' : item?.kind === 'note' ? '图文笔记' : '文章', item?.verdict_tier ?? '待判']),
      node('section', {}, [
        node('h5', {}, ['为什么给你']),
        node('p', { className: r.text ? '' : 'bl-missing' }, [r.text || '（这条没写理由）']),
        r.keywords.length ? node('p', { className: 'bl-kw' }, ['命中词：' + r.keywords.join('、') + (r.groups.length ? `（${r.groups.join('、')}）` : '')]) : null
      ]),
      node('section', {}, [
        node('h5', {}, [item?.kind === 'video' ? '字幕原文' : '正文']),
        node('p', {}, [item?.body_text || '（读不到内容，所以这条本来也不该出现）'])
      ]),
      boundaryNote(item) ? node('section', {}, [node('h5', {}, ['能力边界']), node('p', {}, [boundaryNote(item)])]) : null,
      item?.url ? node('section', {}, [node('h5', {}, ['链接']), node('p', {}, [item.url])]) : null,
      node('p', { className: 'bl-note' }, ['两个按钮只调来源权重，不改你的主题词；当前偏移在设置页能看到也能一键归零。'])
    ]),
    node('footer', { className: 'bl-dbtns' }, [
      node('button', { type: 'button', title: feedbackHint('dismiss'), onClick: () => fire('dismiss') }, ['不感兴趣']),
      node('button', { type: 'button', className: 'bl-save', title: feedbackHint('save'), onClick: () => fire('save') }, ['收藏'])
    ])
  ])
}
```

- [ ] **Step 4: 接进装配层、跑全量、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/views/drawer.js src/client/_header.txt test/views-drawer.test.js client.js
git commit -m "feat: 条目抽屉（命中理由、原文、能力边界、只写 tuning 的反馈）"
```

---

## Task 9: CSS——零硬编码颜色，明暗都过

**Files:**
- Create: `src/client/css.js`
- Test: `test/css.test.js`

**Interfaces:**
- Consumes: 宿主主题变量 `--dsw-alias-*` / `--dsw-static-*`
- Produces: `CSS`（字符串）、`TOKEN_FALLBACKS`（每条 token 的 `light-dark()` fallback 表）、`injectStyles()`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { CSS, FALLBACKABLE } from '../src/client/css.js'

test('CSS 里没有硬编码颜色（十六进制、rgb、颜色名都不许）', () => {
  const offenders = []
  const hex = /#[0-9a-fA-F]{3,8}\b/g
  const rgb = /\brgba?\(/g
  const named = /:\s*(?:white|black|red|green|blue|gray|grey|silver)\b/g
  for (const re of [hex, rgb, named]) { let m; while ((m = re.exec(CSS))) offenders.push(m[0]) }
  assert.deepEqual(offenders, [], '硬编码颜色：' + offenders.join(', '))
})

test('每个用到的 token 都有 light-dark fallback，所以脱离宿主也能看', () => {
  const used = [...CSS.matchAll(/var\((--dsw-[a-z0-9-]+)([^)]*)\)/g)].map(m => m[1])
  assert.ok(used.length > 8)
  for (const t of new Set(used)) {
    const withFallback = new RegExp(`var\\(${t}\\s*,\\s*light-dark\\(`)
    assert.ok(withFallback.test(CSS), `${t} 没有 light-dark fallback：明暗预览会糊成一片`)
  }
  assert.ok(FALLBACKABLE.size >= used.length)
})

test('网格用 auto-fill minmax，不留两侧空白也不固定宽度', () => {
  assert.match(CSS, /grid-template-columns:\s*repeat\(\s*auto-fill\s*,\s*minmax\(\s*232px\s*,\s*1fr\s*\)\s*\)/)
  // 只禁容器自己限宽；@media (max-width:820px) 这种断点当然允许
  assert.doesNotMatch(CSS.replace(/@media[^{]*\{/, '@media{'), /\.(?:bl-root|bl-body|bl-grid|bl-two)[^}]*max-width/)
  assert.match(CSS, /\.bl-root\s*\{[^}]*width:\s*100%/)
})

test('字号只有 13/12/11，字重只有 400/500', () => {
  const sizes = [...CSS.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1]))
  assert.ok(sizes.length > 3)
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [11, 12, 13])
  const weights = [...CSS.matchAll(/font-weight:\s*(\d{3})/g)].map(m => m[1])
  assert.deepEqual([...new Set(weights)].sort(), ['400', '500'])
})

test('可点目标不低于 32px，且尊重 reduced-motion', () => {
  assert.match(CSS, /min-height:\s*32px/)
  assert.match(CSS, /prefers-reduced-motion:\s*reduce/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/css.test.js`
Expected: FAIL — 找不到 `../src/client/css.js`

- [ ] **Step 3: 写 `src/client/css.js`**

```js
/**
 * 所有颜色都从宿主 token 取，一个硬编码色都没有：换主题（catppuccin / mocha / mica）
 * 这里自动跟着变，是「融进主题」而不是「自带皮肤」。
 * 每个 token 配一个 light-dark() fallback，这样在纯浏览器预览里明暗两版都成立。
 */
export const FALLBACKABLE = new Map([
  ['--dsw-alias-bg-base', 'light-dark(#fbfbfc, #16171b)'],
  ['--dsw-alias-fill-tertiary', 'light-dark(#f3f4f6, #1f2126)'],
  ['--dsw-alias-fill-secondary', 'light-dark(#e9ebef, #282b31)'],
  ['--dsw-alias-label-primary', 'light-dark(#1c1e22, #e6e8ec)'],
  ['--dsw-alias-label-secondary', 'light-dark(#6b7280, #9aa1ac)'],
  ['--dsw-alias-border-primary', 'light-dark(#e2e4e9, #2e3138)'],
  ['--dsw-alias-border-secondary', 'light-dark(#d2d5db, #3c4048)'],
  ['--dsw-alias-link', 'light-dark(#2f6f5e, #78b8a4)']
])

const TIER = {
  good: 'var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4))',
  ok: 'var(--dsw-alias-fill-tertiary, light-dark(#8a6a1f, #cfae55))',
  bad: 'var(--dsw-alias-border-secondary, light-dark(#a4443c, #d47b73))'
}

export const CSS = `
.bl-root{display:flex;flex-direction:column;gap:0;width:100%;min-width:0;height:100%;background:var(--dsw-alias-bg-base, light-dark(#fbfbfc, #16171b));color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec));font-size:13px;line-height:1.5}
.bl-root *{box-sizing:border-box;font-weight:400}
.bl-nav{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--dsw-alias-fill-tertiary, light-dark(#f3f4f6, #1f2126));border-bottom:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138));overflow-x:auto;scrollbar-width:thin}
.bl-brand{font-size:13px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec))}
.bl-navlist{display:flex;gap:2px;flex:1;min-width:0}
.bl-navitem{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));font-family:inherit;font-size:13px;padding:6px 10px;min-height:32px;border-radius:7px;cursor:pointer;white-space:nowrap}
.bl-navitem:hover{background:var(--dsw-alias-fill-secondary, light-dark(#e9ebef, #282b31));color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec))}
.bl-navitem[aria-current="page"]{background:var(--dsw-alias-fill-secondary, light-dark(#e9ebef, #282b31));color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec));font-weight:500}
.bl-body{padding:14px 16px 20px;min-width:0;flex:1;overflow-y:auto}
.bl-toolbar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-bottom:12px}
.bl-toolbar select,.bl-toolbar input{font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-secondary, light-dark(#d2d5db, #3c4048));border-radius:6px;background:var(--dsw-alias-fill-tertiary, light-dark(#f3f4f6, #1f2126));color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec))}
.bl-toolbar input{flex:1;min-width:130px}
.bl-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(232px, 1fr));gap:12px}
.bl-rail{margin-top:18px}
.bl-rail h3{font-size:13px;font-weight:500;margin:0 0 8px}
.bl-card,.bl-row{appearance:none;text-align:left;font-family:inherit;color:inherit;background:var(--dsw-alias-fill-tertiary, light-dark(#ffffff, #1f2126));border:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138));border-radius:8px;padding:9px 10px;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-height:32px}
.bl-card:hover,.bl-row:hover,.bl-row[aria-selected="true"]{background:var(--dsw-alias-fill-secondary, light-dark(#f3f4f6, #282b31));border-color:var(--dsw-alias-border-secondary, light-dark(#d2d5db, #3c4048))}
.bl-card:focus-visible,.bl-row:focus-visible,.bl-navitem:focus-visible{outline:2px solid var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4));outline-offset:2px}
.bl-thumb{position:relative;aspect-ratio:16/9;border-radius:6px;background:var(--dsw-alias-fill-secondary, light-dark(#e9ebef, #2c3540));display:block}
.bl-dur{position:absolute;right:5px;bottom:5px;font-size:11px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-fill-secondary, light-dark(#e9ebef, #282b31));color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac))}
.bl-card-title{font-size:13px;line-height:1.4}
.bl-card-meta,.bl-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));display:flex;gap:6px;flex-wrap:wrap}
.bl-why,.bl-row-why{font-size:12px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));border-left:2px solid var(--dsw-alias-border-secondary, light-dark(#d2d5db, #3c4048));padding-left:7px;margin-top:auto}
.bl-tier{font-size:11px;color:var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4))}
.bl-play{font-size:11px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac))}
.bl-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:14px;align-items:start}
.bl-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.bl-reader{background:var(--dsw-alias-fill-tertiary, light-dark(#ffffff, #1f2126));border:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138));border-radius:8px;padding:13px 15px;min-height:200px}
.bl-reader h4{margin:0 0 4px;font-size:14px;font-weight:500}
.bl-reader-by,.bl-reader-hint,.bl-reader-link{font-size:11px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));margin:0 0 8px}
.bl-reader-body{font-size:13px;white-space:pre-wrap;word-break:break-word}
.bl-facets{display:flex;flex-direction:column;gap:12px;font-size:12px}
.bl-facets h4{margin:0 0 4px;font-size:12px;font-weight:500}
.bl-facets label{display:flex;gap:6px;align-items:center;min-height:26px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac))}
.bl-library{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start}
.bl-empty,.bl-empty-state,.bl-note,.bl-more,.bl-count,.bl-summary,.bl-gaps,.bl-issues,.bl-pending{font-size:12px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac))}
.bl-summary{font-size:13px;color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec))}
.bl-issues{color:var(--dsw-alias-border-secondary, light-dark(#a4443c, #d47b73))}
.bl-drawer{position:sticky;top:0;background:var(--dsw-alias-fill-tertiary, light-dark(#ffffff, #1f2126));border:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138));border-radius:8px;display:flex;flex-direction:column;max-height:80vh;overflow:hidden}
.bl-dbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138))}
.bl-dbar button{appearance:none;font-family:inherit;font-size:12px;min-height:28px;padding:4px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary, light-dark(#d2d5db, #3c4048));background:transparent;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));cursor:pointer}
.bl-dmain{padding:12px 14px;display:flex;flex-direction:column;gap:11px;overflow-y:auto;font-size:12px}
.bl-dmain h4{margin:0;font-size:14px;font-weight:500;line-height:1.4}
.bl-dmain h5{margin:0 0 3px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac))}
.bl-dmain p{margin:0;word-break:break-word}
.bl-badge{font-size:11px;color:var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4))}
.bl-dbtns{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138))}
.bl-dbtns button{flex:1;appearance:none;font-family:inherit;font-size:12px;min-height:32px;border-radius:7px;border:1px solid var(--dsw-alias-border-secondary, light-dark(#d2d5db, #3c4048));background:transparent;color:var(--dsw-alias-label-primary, light-dark(#1c1e22, #e6e8ec));cursor:pointer}
.bl-dbtns .bl-save{border-color:var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4));color:var(--dsw-alias-link, light-dark(#2f6f5e, #78b8a4))}
.bl-missing{color:var(--dsw-alias-border-secondary, light-dark(#a4443c, #d47b73))}
.bl-stale{font-size:12px;color:var(--dsw-alias-label-secondary, light-dark(#6b7280, #9aa1ac));padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-primary, light-dark(#e2e4e9, #2e3138));background:var(--dsw-alias-fill-secondary, light-dark(#f3f4f6, #282b31))}
@media (max-width:820px){.bl-two{grid-template-columns:minmax(0,1fr)}.bl-library{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.bl-root *{transition:none;animation:none}}
`

let injected = false
export function injectStyles() {
  if (injected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.setAttribute('data-baleen', '')
  el.textContent = CSS
  ;(document.head ?? document.body)?.appendChild?.(el)
  injected = true
}
```

**注意 `TIER` 常量目前没被 CSS 字符串用上**——写它就得删掉（YAGNI）；三档的颜色区分靠上面 `.bl-tier` 一条 + 文案本身，别为了"三档三色"再加一套色板。**执行时删掉 `TIER` 未使用的定义**，第一条测试不会管这个，但 `node -e` 手查一遍未使用导出。

- [ ] **Step 4: 装配层注入样式**

`Panel` 首行 `injectStyles()`（在 `client.js` 生成体里 `import` 之后调用一次即可）。

- [ ] **Step 5: 跑全量、生成、提交**

```bash
node tools/build-client.mjs && node --test "test/*.test.js"
git add src/client/css.js src/client/_header.txt test/css.test.js client.js
git commit -m "feat: 面板样式（零硬编码颜色、auto-fill 网格、明暗 fallback）"
```

---

## Task 10: 预览门——同一批渲染函数出假数据 HTML（明暗两版）

这是你要求的"定稿前必须看预览"的落地：**预览用真渲染函数**，所以它不是另画一套，而是同一份代码在浏览器里的样子。

**Files:**
- Create: `tools/preview.mjs`
- Test: `test/preview.test.js`

**Interfaces:**
- Consumes: `src/client/views/*.js`、`src/client/css.js`、`test/fixtures/preview-data.js`
- Produces: `out/preview-today.html`、`out/preview-video.html`、`out/preview-article.html`、`out/preview-digest.html`、`out/preview-library.html`、`out/preview-drawer.html`，每个文件内含明暗两块

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderPreview } from '../tools/preview.mjs'

test('五个视图 + 抽屉都出 HTML，明暗两块都有', () => {
  const files = renderPreview({ outDir: fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'preview-')) })
  assert.deepEqual(files.map(f => path.basename(f)).sort(), [
    'preview-article.html', 'preview-digest.html', 'preview-drawer.html',
    'preview-library.html', 'preview-today.html', 'preview-video.html'
  ])
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8')
    assert.match(html, /class="bl-root"[^>]*data-preview="light"/)
    assert.match(html, /class="bl-root"[^>]*data-preview="dark"/)
    assert.doesNotMatch(html, /<script/, '预览是静态产物，不该带脚本')
  }
})

test('空态在预览里也看得见（不许只渲染有数据的版本）', () => {
  const files = renderPreview({ outDir: fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'preview-empty-')), empty: true })
  const digest = fs.readFileSync(files.find(f => f.includes('digest')), 'utf8')
  assert.match(digest, /判断轮（M3）尚未接入/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/preview.test.js`
Expected: FAIL — 找不到 `../tools/preview.mjs`

- [ ] **Step 3: 写 `tools/preview.mjs`**

核心是**一个极简渲染器 + 五个真视图函数**，不引 React：

```js
import fs from 'node:fs'
import path from 'node:path'
import { CSS } from '../src/client/css.js'
import { TodayView } from '../src/client/views/today.js'
import { VideoView } from '../src/client/views/video.js'
import { ArticleView } from '../src/client/views/article.js'
import { DigestView } from '../src/client/views/digest.js'
import { LibraryView } from '../src/client/views/library.js'
import { Drawer } from '../src/client/views/drawer.js'
import { previewState, previewItems } from '../test/fixtures/preview-data.js'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 把 {type,props,children} 直接吐成 HTML。桩与真渲染共用同一形状，所以预览不需要 React。 */
export function toHtml(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props = {}, children = [] } = node
  const attrs = Object.entries(props)
    .filter(([k, v]) => v !== undefined && v !== null && v !== false && typeof v !== 'function' && k !== 'onClick' && k !== 'onChange')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('')
  const inner = [].concat(children).map(toHtml).join('')
  return `<${type}${attrs}>${inner}</${type}>`
}

function page(title, blocks) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;padding:18px;background:#0f1114;font-family:system-ui,sans-serif}
[data-preview="light"]{--dsw-alias-bg-base:#fbfbfc;--dsw-alias-fill-tertiary:#fff;--dsw-alias-fill-secondary:#e9ebef;--dsw-alias-label-primary:#1c1e22;--dsw-alias-label-secondary:#6b7280;--dsw-alias-border-primary:#e2e4e9;--dsw-alias-border-secondary:#d2d5db;--dsw-alias-link:#2f6f5e;color-scheme:light}
[data-preview="dark"]{--dsw-alias-bg-base:#16171b;--dsw-alias-fill-tertiary:#1f2126;--dsw-alias-fill-secondary:#282b31;--dsw-alias-label-primary:#e6e8ec;--dsw-alias-label-secondary:#9aa1ac;--dsw-alias-border-primary:#2e3138;--dsw-alias-border-secondary:#3c4048;--dsw-alias-link:#78b8a4;color-scheme:dark}
.bl-block{margin:0 0 22px;padding:0}
.bl-block>figcaption,.bl-cap{color:#9aa1ac;font:12px system-ui,sans-serif;margin:0 0 7px}
${CSS}</style></head><body>
${blocks.map(b => `<p class="bl-cap">${esc(b.label)}</p><div class="bl-block">${toHtml(b.node)}</div>`).join('\n')}
</body></html>\n`
}

export function renderPreview({ outDir, empty = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const state = empty ? { counts: { new: 4, total: 4 }, digest_count: 0, sources: [], last_run: null } : previewState
  const items = empty ? [] : previewItems
  const views = {
    'today': { label: '今天', node: TodayView({ state, items }) },
    'video': { label: '视频', node: VideoView({ state, items, filters: {} }) },
    'article': { label: '文章', node: ArticleView({ state, items, filters: {}, selectedId: items[0]?.id }) },
    'digest': { label: '汇报', node: DigestView({ digests: [], state: { ...state, digest_count: 0 } }) },
    'library': { label: '库', node: LibraryView({ items, filters: {} }) },
    'drawer': { label: '抽屉', node: Drawer({ item: items[0] ?? { id: 1, source_id: 'a', title: '（空库）', match_json: '{}' }, api: {} }) }
  }
  return Object.entries(views).map(([id, v]) => {
    const file = path.join(outDir, `preview-${id}.html`)
    fs.writeFileSync(file, page(`Baleen 预览 · ${v.label}`, [{ label: '明', node: v.node }, { label: '暗（同一份代码，只换 token）', node: v.node }]), 'utf8')
    return file
  })
}

if (process.argv[1]?.endsWith('preview.mjs')) {
  const files = renderPreview({ outDir: path.join(process.cwd(), 'out') })
  console.log(files.join('\n'))
}
```

`test/fixtures/preview-data.js` 手工写 8 条条目（B 站视频、小红书视频笔记、Substack 全文、Medium 仅摘要、少数派、HN、库存一条 `judged/不值当`、一条 `burned_in`）+ 一份含 `gaps` 的 `previewState`。**内容要用真结构、假标题**，别把她的真实订阅源名写进这个仓库。

**汇报那一页在预览里就是空态**（M3 未接入，`digest_count: 0`），这是故意的——不许为了让预览"好看"而塞假简报进去。你看预览时那一页应该只有一行说明文字。

- [ ] **Step 4: 生成预览并截图验收（明暗两版）**

```bash
node tools/preview.mjs
```
然后用本机无头 Edge 对每个文件截图（`--window-size` 有约 643px 下限，窄视口要走 iframe 探针那招），明暗各一张存 `out/shots/`。**这一步是人看的门**：把图交给用户确认布局，再进真机装载。

- [ ] **Step 5: 提交**

```bash
git add tools/preview.mjs test/preview.test.js test/fixtures/preview-data.js out/preview-*.html
git commit -m "feat: 假数据预览门（真渲染函数出 HTML，明暗两版）"
```

---

## Task 11: 真机装载与面板验收（需要用户退出 DSH）

⚠️ 会动 profile 并重启应用。**开始前必须**：确认她已退出 DSH（不是关窗口——关窗口只隐藏到托盘，主进程还活着）；确认 M1 那两个备份还在（`cordis.patch.yml.bak-before-baleen-<ts>`、`package.json.bak-before-baleen-<ts>`）；记住条目数基线 patch 40 / deps 36 / bundles 47；一次只切一个插件；**绝不点启动失败弹窗里"禁用第三方插件、备份 profile patch 并重启"**。

- [ ] **Step 1: link 装进 desktop profile，先用 `--dump-config` 免重启验装配**

```bash
D="/d/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
"$D" plugin --profile desktop add link:D:/dsh-baleen
"$D" --profile desktop --dump-config 2>&1 | grep -n -A3 "dsh-baleen"
```
Expected: 能看到 `name: dsh-baleen`（或 `file:///.../client.js` 形态）。看不到就别急着重试，先检查 `dsh.client` 声明有没有写错。

- [ ] **Step 2: 打包 pnpm 装依赖**

```bash
cd /d/DSH/.dsh/profiles/desktop
D:/nodejs/node.exe "D:/Program Files/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
```
`yaml` 被 24h `minimumReleaseAge` 拒时：把它写进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，**精确版本号**，改前先备份那个文件。

- [ ] **Step 3: 她重启 DSH（不代劳），启动后查这些**

```bash
ls -t "/c/Users/<USER>/AppData/Roaming/@deepseek-ai/dsh-desktop/logs/" | head -3   # 路径脱敏，实机用 $APPDATA
```
Expected: **没有新增** `crash-*-web-boot.log`。注意成功启动会**清掉**旧日志，所以要比文件名不比数量。有新增就读它，`1 entry did not activate … dsh-baleen` 说明客户端半或宿主半装配失败——第一嫌疑是 `inject` 里少了服务名（Proxy 会抛，且抛在 `apply()` 里）。

- [ ] **Step 4: 面板逐项验收（她眼睛看，我按清单核）**

1. 侧边栏出现「Baleen」，点进去不白屏。
2. 顶部五项导航能切，「今天」是落点；待判数字出现在"今天"上。
3. 点一条卡片出抽屉，"为什么给你"里有真实理由；两个按钮点一下，设置里没有它们，但 `preference.yaml` 的 `tuning.source_delta` 多了一行、`themes` 没动（跑 `git diff` 式比对：读文件前后各一次）。
4. 切到视频/文章/库，各自筛选生效；空筛选结果显示的是"这个筛选太窄"而不是空白。
5. 汇报区显示"判断轮（M3）尚未接入"，**不许出现任何假总结**。
6. 明暗主题各看一次（在 DSH 里切主题），卡片、徽章、抽屉都跟着变，没有一处白底白字。
7. 把 DSH 主区拉窄，两栏退单列、导航收成可横滚一行。
8. 关掉面板再回来，视图与筛选还在（`localStorage` 还原）。

- [ ] **Step 5: 把结果写进 `docs/verification.md`（V4 与面板项）并提交**

```bash
git add docs/verification.md
git commit -m "docs: M2 真机装载与面板验收记录"
```

---

## 本计划不做

- 设置页四页签（M5）。本里程碑 `settings.section` 槽位**不注册**，所以两个反馈按钮的效果只能从 `preference.yaml` 里看到——这是刻意的，不要顺手在面板里加一个"设置"入口。
- 判断轮、`baleen.*` 工具注册、system-prompt 注入（M3）。汇报区因此只能是空态。
- B 站内嵌播放器的真实 iframe 与 V5 实测（M4）；本计划只做文案与降级位。
- 平台适配器与凭据（M4）。
- 任何 push / 发布 / 建仓动作——对外一律先出草稿等她批准。

## 实现偏差记录（M2 落地时，以代码为准）

1. **两个反馈按钮不写 `preference.yaml`，改写 `tuning.json`**（计划原话是"写回 yaml"）。原因是一条测试逼出来的：`YAML.stringify` 会重排整个文件并丢掉注释，`any: [MCP]` 被展开成块——用户手编辑的配置不该因为"点了下不感兴趣"就变样。加载时按 `{...yaml 的 tuning, ...tuning.json}` 合并，json 赢；累加到 0 就删键，越界夹在 ±0.5，坏 json 当没有。宿主 `/feedback` 的拒绝路径现在也有断言保证**两个文件都不碰**。
2. 取数层从骨架里的内联 `makeStore` 拆成 `src/client/view-api.js` 的 `createApi`，`PARTS` 加一项即生成进 bundle。**API 常量只留一份**：原先 `_header.txt` 的 `API` 与 view-api 的 `API_BASE` 同值重名，生成后落在同一作用域（这是 bundle 生成方式带来的新约束，以后加源文件都要注意）；现在删掉 `API`，`__test` 与测试都改断 `API_BASE`，一个事实一个名字。
3. 桩补了 `exportsOf` / `flattenText`：断言文案用压平文本比逐层断结构耐改，`createElement` 的节点形状在桩和预览里同构。
4. 视图状态多测了三件事：`filters` 里的非对象值要丢掉（否则下次 reduce 会崩）、空串筛选值是删除而非存空、未知 action 必须**返回同一个对象**（不产生新引用，省掉无谓重渲染）。
5. 计划里 Task 4 那句"客户端内联一份、测试逐字节比对"作废，改为 `src/client/` + `tools/build-client.mjs` 生成 + `test/build.test.js` 盯陈旧产物；`--check` 模式留给以后可能的 CI。
6. **`vnode.js` 是计划里没有的文件**。`views/today.js` 与 `views/placeholder.js` 各自写了 `const node = ...`，内联进同一个 factory 作用域就是 `SyntaxError: Identifier 'node' has already been declared`。把节点工厂提到 `src/client/vnode.js` 的 `vnode()`，两个视图都 import 它（生成时 import 行被剥掉，只剩一份定义）。加视图请沿用 `vnode`，别再本地造同名 const。
7. **`flattenText` 现在会调用函数组件**：`main` 槽返回的是 `h(Panel, {key})`，桩不 reconcile，压平出来是空串——于是"Panel 落地在今天"这条断言一度对着 `''` 通过。桩里加了 `typeof node.type === 'function'` 分支（按 React 的做法把组件调一层），并单独立一条测试钉住它，否则以后所有面板断言都可能静默空转。
8. **装配层新增 `toElement()`**（计划 Step 4 只说了"装配层负责交给 React"，没写实现）：递归 `h(type, props, ...children)`，`null/false` 归零，数组子节点补 index key（宿主 dev 模式缺 key 会刷屏）。视图本身不碰 React，才能在 Node 里断言、也才能被 Task 10 的预览器复用。
9. **两个新增守卫**：`test/build.test.js` 断言 `src/client` 下每个 `.js` 都在 `PARTS` 里（漏了等于白写，面板不会变）；`test/client-boot.test.js` 断言 `Object.keys(VIEW_RENDER)` 与 `VIEWS` 一字不差，因此 `Panel` 里不再留 `|| VIEW_RENDER.today` 的兜底。另：`initialView()` 去掉了 `persisted` 形参——`decodeState(对象)` 会静默回落默认值，是个陷阱；持久化的读法只有一条路，就是装配层把 `localStorage` 原文交给 `decodeState`。
10. **`match.js` 也是计划里没有的文件**：`views/today.js` 与 `views/video.js` 各写了一份 `reasonOf`，内联后 `SyntaxError: Identifier 'reasonOf' has already been declared`——同作用域重名这条约束不是纸上谈兵，第二个视图就撞上了。命中理由的读法提到 `src/client/match.js` 共用。
11. **`findAll` 与 `flattenText` 一样要调用函数组件**：`main` 槽返回 `h(Panel)`，不调一层就永远找不到 `bl-toolbar`，而"找不到"表现为空数组——看起来像实现漏了节点，其实是桩没展开。两处各立一条测试钉住，因为一旦退化，后面所有面板断言都会静默空转。
12. **`listItems` 的 `status` 支持逗号串或数组**（`new,judged,digest` → SQL `IN`）：三个视图都要"没归档的"。只传 `status=new` 不够（判过的要看档位），不限状态又会让归档条目挤占 `limit` 名额、面板看起来像"库变小了"。`/items?status=` 原样透传，路由不用改。
13. **面板按视图决定查询**：`library` 用 `{limit:500}`（含归档），其余用 `{status:'new,judged,digest', limit:200}`；`useEffect` 依赖 `snap.view`，从「库」切回「今天」会重新取活着的那批。
14. `fmtDuration` 的秒数取整（`Math.floor`）再拼，避免非整数秒在徽章上出现 `1:2:3.5`。工具条的搜索框用 `placeholder` 属性给文案，所以"接上真渲染器"那条断言改看 `显示 0 / 0 条`——`flattenText` 只收 children，读不到属性里的字。
15. **文章区的"选中"与"抽屉"拆成两份状态**（计划里 ArticleView 的 `onOpen` 一词双用）。点左栏一行只换右栏（`{type:'select', id}` → `selectedId`），进抽屉改走右栏的"详情与反馈"按钮（`bl-detail`）。理由：两栏阅读本来就是常驻正文，若点一行就弹抽屉，抽屉与右栏显示同一条内容，而反馈入口反倒只能在抽屉里看到——把"读"和"判"混在一个动作上。`view-state` 因此多了 `selectedId` 字段并参与编解码，切视图不清它。
16. `STATE_HINT.burned_in` 的说法统一成"硬字幕读不到"打头（与 `today.js` 的 `FLAG_LABELS`、`video.js` 的 `STATE_LABELS` 同一个词），后面再补"字烧在画面上"。三处口径不一致会让人以为是三件不同的事。
17. **`facet` 是 reducer 的新动作，不是 `filter` 的变体**。计划 Step 3 里 `onFilter({facet, value, on})` 与 `filter` 动作的 `{view,key,value}` 形状不接（`filters.status` 到底是标量还是数组，两处写得不一样）。现在定死：**库的 facet 值是数组**，组内 OR、组间 AND，`{type:'facet', view, key, value, on}` 由 reducer 负责加/删并在空数组时**删键**——"没筛"和"筛了个空"在 UI 上必须看起来一样。视频/文章的工具条仍是标量单选，两套各走各的动作。
18. **汇报区多了一种诚实情况**：`digestEmptyReason(state, loaded)` 除了"没跑过 / 判断轮没接入"，还要处理 `state.digest_count > 0` 但面板手里没内容（M3 之前没有 `/digests` 读取路由，面板传的是 `digests: []`）。这时说"数得出、读不出来"，而不是画一个空的 `bl-dsum` 列表。
19. `libraryRows` 与 `LibraryView` 只渲染前 100 条并写出"还有 N 条"——面板没有分页控件之前，静默截断等于谎报"库就这么大"。库里 archived 条目带上 `archived_reason`，让"为什么不见了"在库里能自查。
20. 占位文件到这一步只剩 `Drawer`（Task 8 接完就删）。`test/client-boot.test.js` 新增一条"五个视图都接上了：面板里不该再有占位字样"的遍历断言——逐个视图渲染并查文案，比记住"哪个任务该删哪个导出"可靠。`views/placeholder.js` 已随 Task 8 删除，`Drawer` 落地后它没有别的导出可留。
21. **计划 Step 1 那段抽屉测试自己有个坑**：`const item = (over) => ({...})` 是个构造函数，而测试写的是 `Drawer({ item, api: {} })`——把函数本身当条目传进去了，于是渲染的是"没有条目"分支，`assert.match(t, /命中 DSH/)` 这类断言看着像通过了结构检查，其实一直在断空壳。落地时改成 `Drawer({ item: item(), ... })`，并额外加一条"条目不在手里"的显式测试，让那个分支成为**被测行为**而不是漏传参数的副作用。
22. **抽屉的入参是 `item` 而不是 `id + items`**：装配层负责从 `data.items` 里把 `snap.drawerItemId` 解析出来；解析不到时抽屉渲染一句解释（"这条不在当前列表里，去「库」里按状态找"）并给关闭按钮——抽屉**开着**与抽屉**有内容**是两件事，合并成一个分支会让人以为点没反应。
23. **`boundaryNote` 现在是"能不能播 + 能不能读"两句拼接**，不是计划的 if 链一出口。原因：一条 B 站硬字幕视频走到第一个分支就返回了播放器的说法，"其实内容读不到"这条最该说的信息被盖掉。状态说法与正文区共用同一张 `STATE_NOTE` 表（`summary_only`/`missing`/`burned_in` 三种算能力边界，`subtitle`/`transcribed` 只是来源说明）。
24. **反馈结果的回显在装配层**（`feedbackMsg` 状态 + 抽屉里的 `bl-feedback` 一行）。计划片段里的 `actions.push(msg)` 是个推进完就丢的局部数组——刷新即蒸发，等于"点了不知道有没有用"。关闭抽屉时清掉这行。
25. M2 的抽屉**不许许诺 M4 的能力**：B 站那句从"抽屉内尝试内嵌播放器"改成"内嵌播放器在 M4 接入，现在只能跳到浏览器里看"。
26. **计划里那份 CSS 的 token 名是本机没有的**。`--dsw-alias-fill-tertiary` / `--dsw-alias-border-primary` / `--dsw-alias-link` 在 dsh-study-desk（0.2.1-rc.2 上已跑通）里一次都没出现过；真名是 `--dsw-alias-bg-layer-1..3`、`--dsw-alias-border-l1..l4`、`--dsw-alias-brand-primary`、`--dsw-alias-label-tertiary/dimmed`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-error-primary`。写错名字不是"风格差异"，是宿主取不到值、整块裸奔。`test/css.test.js` 里钉了一张 allowlist，注释写明来源。
27. **不设 `light-dark()` 内联兜底**（计划 Step 3 通篇是 `var(--x, light-dark(#..,#..))`）。那条写法等于把硬编码颜色请回这份文件，"零硬编码颜色"就退化成"颜色都有兜底"。现在 `CSS` 里一个颜色字面量都没有，测试也简单得多：整串扫十六进制/函数式/颜色名，命中即红。脱离宿主的样子交给预览器——`tools/preview.mjs` 自己声明一张**标明是替身**的 token 表分明暗两块。测试另加一条"var() 不许带兜底"，防止有人好心加回来。
28. 网格 `minmax(260px, 1fr)`（计划写的是 232px）。AGENTS.md 里"不留两侧大空白"那条给的就是 260px，以它为准。
29. **类名与样式的对齐由测试双向扫**：`viewSources()` 抓 `src/client/**` 里所有含 `bl-` 的字符串字面量（不只 `className: 'x'` 这种直接形式——`className: ok ? '' : 'bl-missing'` 用前者会整类漏掉），逐个查 CSS 里有没有对应选择器。第一版就按直接形式扫时确实漏了 `bl-missing`。
30. `is-video` 这个类删了（没有任何样式引用它，纯属"以后可能用"）；`.bl-actions button` / `.bl-detail` 这些新控件补进交互样式，`min-height:32px` 统一用于可点目标，facet 的 label 也从计划的 26px 提到 32px。
31. `injectStyles()` 在 `apply()` 里调一次（不是计划的"Panel 首行"）：Panel 是渲染函数，渲染几次就可能调几次，虽然内部有 `injected` 旗标兜着，但把幂等测试（"样式表只注入一次"）放在装配入口更对得上它的语义。
32. **预览必须带外壳，不然这一门白过**。计划 Step 3 直接把 `TodayView(...)` 塞进页面，那她看到的是没有导航的一屏卡片——而当初定的正是"像网站那样，顶部是导航栏"，没法评。为此把 `Nav`/`TopBar`/`NotReady` 从 `_footer.txt` 提到 `src/client/views/shell.js`（纯 vnode，与视图同构），装配层与预览器共用同一份；预览每页现在渲染 `TopBar + Nav + main + 抽屉`。**注意 `h(Nav)` 这种写法要改成 `toElement(Nav({...}))`**：函数组件返回普通对象的话真 React 会抛 "Objects are not valid as a React child"。
33. **预览器要把手写 HTML 的属性名换掉**：视图里的 `className` 直接吐出去就是 `className="bl-card"`，浏览器不认，于是**整页样式静默失效**——第一版截图看着"排版很奇怪"就是这么来的（Edge 还回 rc=0，一点错误都不报）。`toHtml` 现在过一张 `ATTR_NAME` 表（`className→class`、`htmlFor→for`、`tabIndex→tabindex`），测试也钉住 `doesNotMatch(/className=/)`。
34. `fmtDuration` / `fmtTime` 提到 `src/client/format.js`。起因是预览截图上今天区的时间徽章写着 `1102`——`today.js` 当时直接 `String(duration_sec)`，而 `video.js` 有 mm:ss，两份实现漂移了。`digestTime` 一并并成 `fmtTime`。加视图请从这里 import，别再造第三个版本。
35. 预览多出一页 **`preview-trouble.html`**：异常带（接口没答上 + 手动那轮失败 + 偏好文件报错）、失败源文案、空轨道文案，平时要等真坏了才看得见，预览里先演一遍给你看。抽屉那页也不再孤零零一个框，背后是面板。
36. `out/shots/` 的无头 Edge 截图在这台机器上不稳定（同一条命令有时 rc=0 却不落文件，本机还开着她自己的 Edge，21 个 msedge 进程在场）。**交付物改成 HTML 本体**（浏览器直接打开就是明暗两块），截图不作为验收项。真机那一步另说。
37. **M2.5（`2026-10-24-baleen-collections-m25.md`）落地后，本计划几处验收口径变了；判据原文保留不撤——它们是 M2 当时的验收记录**：交付判据 2 的「六份 HTML」如今是八份（M2 落地时偏差 35 已多出 `preview-trouble.html`，M2.5 再加收藏页 `preview-collections.html`）；顶部导航从五格变六格（新增「收藏」格）；抽屉里那颗原计划叫「收藏」的 `bl-save` 按钮改名「这源多来点」（M2.5 Task 7，改名缘由见该计划）。另记 M2.5 Task 5 的一条评审裁定：spec `2026-10-24-baleen-collections-design.md` §7 错误表原写「400 `item_gone`」，与代码、计划的 `404 no_item` 不符，已统一为后者。
38. **M2.5 终审（D2）**：spec `2026-10-24-baleen-collections-design.md` §4 把「收藏页上『移出本夹』」列为 `/collect` 全量替换覆盖的动作，收藏页实现里没有这颗按钮——移出走抽屉取消勾选（同一次提交语义）。binding 的 §6.2 UI 清单（工具条三件事 + 卡面信息）本就没列它，实现符合 §6.2，属 spec 两段措辞不咬合；以 §6.2 为准，不改 spec、不改代码。

## 交付判据

1. `node --test "test/*.test.js"` 全绿，其中 `test/css.test.js` 证明**零硬编码颜色**、`test/build.test.js` 证明 `client.js` 不是手改的陈旧产物。
2. `node tools/preview.mjs` 出的六份 HTML 里，明暗两块都能看到，且**汇报区在空态下也渲染**——把图交她看过点头。
3. 真机：无新增 crash log、侧栏入口能开、抽屉理由真实、反馈按钮只改 `tuning`（前后文件比对为证）。
4. `docs/verification.md` 的 V4 有实测结论；面板八项验收逐条记"过/不过+原因"，不许整片打勾。




## M3 交叉引用（2026-10-25）

M3（判断轮，`2026-10-25-baleen-m3-judgment.md`）落地后，本计划两处"留给 M3"的文案兑现：今天格待判提示的"（M3 接入后这里会自动提示）"改为对会话说的真提示；汇报视图"判断轮（M3）尚未接入"空态改为"已接入但还没跑过判断"的指向句。本计划的"设置页四页签（M5）"仍按计划未动，`settings.section` 槽位继续不注册。
