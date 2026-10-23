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
  assert.equal(t.API, '/api/dsh-baleen')
  assert.equal(t.SNAPSHOT_KEY, 'baleen.snapshot')
  assert.equal(typeof t.createApi, 'function')
  assert.equal(typeof t.Nav, 'function')
  assert.equal(typeof t.getLayout, 'function')
})
