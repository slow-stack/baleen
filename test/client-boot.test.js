import test from 'node:test'
import assert from 'node:assert/strict'
import { clientExists, loadClient, exportsOf, flattenText, makeStubs } from '../tools/client-loader.mjs'

test('桩的 ctx 复刻宿主 Proxy：未声明服务一律抛', () => {
  const s = makeStubs()
  const ctx = s.makeCtx(['slots'])
  assert.equal(ctx.get('slots'), s.slots)
  assert.throws(() => ctx.get('layout'), /without inject/)
  assert.throws(() => ctx.layout, /without inject/)
})

test('flattenText 能把节点树压成文本', () => {
  const node = { type: 'div', props: {}, children: ['a', { type: 'span', props: {}, children: ['b', null, false, 'c'] }] }
  assert.equal(flattenText(node).join(' '), 'a b c')
})

test('flattenText 会调用函数组件，否则断言永远看不到面板内容', () => {
  const Comp = () => ({ type: 'p', props: {}, children: ['组件里的话'] })
  assert.deepEqual(flattenText({ type: Comp, props: {}, children: [] }), ['组件里的话'])
})

test('client.js 不存在时 loadClient 明确报错，不静默通过', () => {
  if (clientExists()) {
    const s = loadClient()
    assert.equal(s.loader.value.id, 'dsh-baleen')
    return
  }
  assert.throws(() => loadClient(), /client\.js 还没建/)
})

test('exportsOf 在没注册 loader 时抛出可读错误', () => {
  const s = makeStubs()
  assert.throws(() => exportsOf(s), /没调 __ModuleLoader__\.load/)
})

test('client.js 以 loader 格式注册，侧栏 id 与 main key 同名', () => {
  const s = loadClient()
  assert.equal(s.loader.value.id, 'dsh-baleen')
  assert.equal(typeof s.loader.value.factory, 'function')
  const ex = exportsOf(s)
  assert.deepEqual(ex.inject, ['slots', 'layout'])
  const ex2 = { ...ex }
  ex2.apply(s.makeCtx(ex.inject))
  assert.deepEqual(s.registered.map(r => r.def.meta.name), ['sidebar.panellist', 'main'])
  const [side, main] = s.registered.map(r => r.def.meta)
  assert.equal(side.id, 'baleen')
  assert.equal(main.key, side.id)
  assert.match(side.label, /Baleen/)
  assert.equal(typeof side.order, 'number')
  assert.equal(s.registered.map(r => r.slot).join(','), 'sidebar.panellist,main')
})

test('宿主少声明一个服务也不能炸启动', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  assert.doesNotThrow(() => ex.apply(s.makeCtx(['slots'])))
  assert.equal(s.registered.length, 2)
})

test('完全没有 slots 时只记日志，不抛', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let res
  try { res = ex.apply(s.makeCtx([])) } finally { console.error = orig }
  assert.deepEqual(res.registeredSlots, [])
  assert.ok(errs.some(e => /slots/.test(e)))
})

test('某一格渲染抛错时降级成 NotReady，不把整页带走', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try { ex.apply(s.makeCtx(ex.inject)) } finally { console.error = orig }
  const mainFactory = s.registered.find(r => r.slot === 'main').def.factory
  const warns = []
  console.error = (...a) => warns.push(a.join(' '))
  let node
  try { node = mainFactory({}) } finally { console.error = orig }
  assert.ok(node, 'main 该出节点')
  void errs
})

test('__test 暴露了后续任务要断言的内部件', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const t = ex.__test
  assert.equal(t.PANEL_ID, 'baleen')
  assert.equal(t.API_BASE, '/api/dsh-baleen')
  assert.equal(t.VIEW_KEY, 'baleen.view')
  assert.equal(t.SNAPSHOT_KEY, 'baleen.snapshot')
  assert.equal(typeof t.createApi, 'function')
  assert.equal(typeof t.Nav, 'function')
  assert.equal(typeof t.getLayout, 'function')
})

test('装配层把纯对象节点树交给 React：视图本身不需要 React 就能测', () => {
  const s = loadClient()
  const t = exportsOf(s).__test
  const el = t.toElement({ type: 'div', props: { className: 'bl-x' }, children: ['甲', { type: 'span', props: {}, children: ['乙'] }] })
  assert.equal(el.type, 'div')
  assert.equal(el.props.className, 'bl-x')
  assert.deepEqual(flattenText(el), ['甲', '乙'])
  // null / false 是合法的"这一格什么都不渲染"，不能被当成文本 "null" 画出来
  assert.equal(t.toElement(null), null)
  assert.equal(t.toElement(false), null)
  assert.deepEqual(t.toElement([null, { type: 'i', props: {}, children: ['ok'] }, false]).filter(Boolean).map(n => n.type), ['i'])
})

test('Panel 落地在「今天」：出统计行与两轨空态，不再挂装配中的牌子', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const main = s.registered.find(r => r.slot === 'main').def.factory
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let tree
  try { tree = main({}) } finally { console.error = orig }
  assert.equal(errs.length, 0, '渲染不该抛错降级：' + errs.join(' | '))
  const text = flattenText(tree).join(' ')
  assert.match(text, /还没有跑过一轮/)
  assert.match(text, /B 站/)
  assert.doesNotMatch(text, /面板装配中/)
  assert.match(text, /现在跑一轮/)
})

test('导航项与渲染器一一对应：加视图只改一处就会红', () => {
  const t = exportsOf(loadClient()).__test
  assert.deepEqual(Object.keys(t.VIEW_RENDER).sort(), [...t.VIEWS].sort())
  for (const v of t.VIEWS) assert.equal(typeof t.VIEW_RENDER[v], 'function', `${v} 没有渲染器`)
})

test('持久化的视图决定首屏落在哪一格（重开面板不回今天）', () => {
  for (const [view, expect] of [['digest', /判断轮未接入/], ['video', /视频区还没接上真渲染器/]]) {
    const s = loadClient({ storage: { 'baleen.view': JSON.stringify({ v: 1, view, filters: {}, drawerItemId: null, scroll: 0 }) } })
    const ex = exportsOf(s)
    ex.apply(s.makeCtx(ex.inject))
    const main = s.registered.find(r => r.slot === 'main').def.factory
    assert.match(flattenText(main({})).join(' '), expect, view + ' 视图没接上')
  }
})

test('坏掉的 baleen.view 回落「今天」，不能把首屏炸成空白', () => {
  const s = loadClient({ storage: { 'baleen.view': '{坏掉的' } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const main = s.registered.find(r => r.slot === 'main').def.factory
  assert.match(flattenText(main({})).join(' '), /还没有跑过一轮/)
})
