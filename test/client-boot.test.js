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
