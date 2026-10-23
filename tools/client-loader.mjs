/**
 * 把 client.js 这个「宿主 loader 格式」的 bundle 在纯 Node 里载进来。
 *
 * 不放 test/ 下：node --test 会把 test 目录里每个文件当一个测试跑，
 * 这个文件没有断言，混进去只会在输出里多出一条假绿。
 *
 * 桩刻意复刻宿主的三个事实，因为实现会撞上去：
 *  1. window.__ModuleLoader__.load({ id, factory })，注册 id 必须等于 loader entry 名；
 *  2. require('react') 给 createElement，require('react-dom') 可能给 createPortal；
 *  3. DSH 的 ctx 是 Proxy：没写进 inject 的服务，ctx.get() 和属性访问都抛
 *     "cannot get property X without inject" —— 这一条是插件炸启动的头号原因，
 *     所以桩必须真的抛，不能给个 undefined 让实现混过去。
 *
 * new Function 只用来执行本仓库自己的 client.js（测试桩要跑真实现，不愿另写一份渲染算法），
 * 输入不是外部数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')

export const CLIENT_PATH = CLIENT
export const VW = 1280
export const VH = 800

export function clientExists() {
  return fs.existsSync(CLIENT)
}

const React = {
  version: 'stub',
  Fragment: Symbol.for('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_sub, get) => get()
}

const ReactDOM = { createPortal: (node) => node }

function requireModule(name) {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`桩里没有这个模块：${name}`)
}

export function makeStubs({ storage = {}, fetchImpl } = {}) {
  const store = { ...storage }
  const registered = []
  const injected = []
  const loader = { value: null }
  const created = []

  const window = {
    __ModuleLoader__: { load: (def) => { loader.value = def } },
    innerWidth: VW, innerHeight: VH,
    addEventListener() {}, removeEventListener() {},
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] }
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  }

  const document = {
    body: null,
    head: { appendChild() {} },
    documentElement: { style: {}, attrs: new Set(), hasAttribute(n) { return this.attrs.has(n) }, setAttribute() {} },
    createElement: () => { const el = { style: {}, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, appendChild() {} }; created.push(el); return el },
    addEventListener() {}, removeEventListener() {}
  }

  const slots = {
    // 照宿主：inject 立即执行工厂，工厂里调 register，注册结果记下来供断言
    inject: (name, fn) => { injected.push(name); registered.push({ slot: name, def: fn() }) },
    register: (meta, factory) => ({ meta, factory })
  }

  /** ctx Proxy 复刻：只有 declared 里的服务读得到，其余一律抛 */
  function makeCtx(declared) {
    const set = new Set(declared)
    const target = {
      get: (name) => {
        if (!set.has(name)) throw new Error(`cannot get service "${name}" without inject`)
        return name === 'slots' ? slots : undefined
      },
      provide: () => {},
      on: () => {},
      effect: (fn) => fn(),
      slots
    }
    return new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return t[prop]
        if (prop === 'get' || prop === 'provide' || prop === 'on' || prop === 'effect') return t[prop]
        if (!set.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return t[prop]
      }
    })
  }

  const fetch = fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))

  return { window, document, React, require: requireModule, slots, registered, injected, loader, makeCtx, store, fetch, created }
}

export function loadClient(opts = {}) {
  if (!clientExists()) throw new Error('client.js 还没建（见计划的客户端骨架任务）')
  const stubs = makeStubs(opts)
  const code = fs.readFileSync(CLIENT, 'utf8')

  globalThis.window = stubs.window
  globalThis.document = stubs.document
  globalThis.localStorage = stubs.window.localStorage
  globalThis.fetch = stubs.fetch
  globalThis.matchMedia = stubs.window.matchMedia
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true })
  } catch { /* 已定义则沿用 */ }

  // 参数名即作用域遮蔽：让 bundle 里的 window/document/require 指向桩
  const run = new Function('window', 'document', 'require', 'fetch', 'localStorage', 'matchMedia', 'navigator', code)
  run(stubs.window, stubs.document, stubs.require, stubs.fetch, stubs.window.localStorage,
      stubs.window.matchMedia, { userAgent: 'node' })

  return stubs
}

/** 取 factory 的 exports（等于宿主装载后拿到的模块对象） */
export function exportsOf(stubs) {
  const def = stubs.loader.value
  if (!def) throw new Error('client.js 没调 __ModuleLoader__.load')
  if (typeof def.factory !== 'function') throw new Error('loader 定义里没有 factory')
  return def.factory(stubs.require)
}

/** 把 {type,props,children} 节点树压成一段文本，断言文案用（比逐层断结构耐改） */
export function flattenText(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((n) => flattenText(n, out))
  else if (typeof node === 'object') {
    // 函数组件按 React 的做法先调用再说，否则 main 槽返回的 h(Panel) 压出来永远是空的
    if (typeof node.type === 'function') flattenText(node.type(node.props ?? {}), out)
    else if ('children' in node) flattenText(node.children, out)
    else Object.values(node).forEach((v) => flattenText(v, out))
  }
  return out
}
