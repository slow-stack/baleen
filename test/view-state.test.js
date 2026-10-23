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
  assert.equal(s.filters.article, undefined)     // 文章区没被视频区的筛选污染
})

test('抽屉记住条目，关闭清空；切视图不动抽屉', () => {
  let s = reduce(initialView(), { type: 'open-drawer', id: 42 })
  assert.equal(s.drawerItemId, 42)
  s = reduce(s, { type: 'pick-view', view: 'library' })
  assert.equal(s.view, 'library')
  assert.equal(s.drawerItemId, 42)
  s = reduce(s, { type: 'close-drawer' })
  assert.equal(s.drawerItemId, null)
})

test('编解码往返，坏数据一律回落默认而不是抛', () => {
  const s = reduce(initialView(), { type: 'filter', view: 'article', key: 'q', value: '治理' })
  assert.deepEqual(decodeState(encodeState(s)), s)
  for (const junk of [null, '', 'not json', '{}', '{"view":"nope"}', '{"filters":5}', '[]']) {
    const d = decodeState(junk)
    assert.equal(d.view, 'today')
    assert.equal(typeof d.filters, 'object')
  }
})

test('未知视图名被忽略而不是把状态打坏', () => {
  const s = reduce(initialView(), { type: 'pick-view', view: 'settings' })
  assert.equal(s.view, 'today')
})

test('空字符串的筛选值是删除该筛选，不是存个空串', () => {
  let s = reduce(initialView(), { type: 'filter', view: 'video', key: 'tier', value: '可以看' })
  s = reduce(s, { type: 'filter', view: 'video', key: 'tier', value: '' })
  assert.deepEqual(s.filters.video, {})
})

test('滚动位置单独记，坏值回落 0', () => {
  assert.equal(reduce(initialView(), { type: 'scroll', top: 320 }).scroll, 320)
  assert.equal(reduce(initialView(), { type: 'scroll', top: 'abc' }).scroll, 0)
  assert.equal(decodeState('{"scroll":"x"}').scroll, 0)
})

test('filters 里的非对象值被丢掉，不会把 reduce 打下次崩溃', () => {
  const d = decodeState('{"filters":{"video":5,"article":{"tier":"值得看"}}}')
  assert.deepEqual(d.filters, { article: { tier: '值得看' } })
  assert.equal(reduce(d, { type: 'filter', view: 'video', key: 'q', value: 'a' }).filters.video.q, 'a')
})

test('阅读选中项与抽屉是两件事：点一行只换右栏，不弹抽屉', () => {
  let s = reduce(initialView(), { type: 'select', id: 7 })
  assert.equal(s.selectedId, 7)
  assert.equal(s.drawerItemId, null)
  s = reduce(s, { type: 'pick-view', view: 'video' })
  assert.equal(s.selectedId, 7, '切视图不该把选中项清掉')
  assert.equal(reduce(s, { type: 'select', id: null }).selectedId, null)
  assert.equal(decodeState('{"selectedId":"x"}').selectedId, null)
  assert.equal(JSON.parse(encodeState(reduce(initialView(), { type: 'select', id: 9 }))).selectedId, 9)
  assert.equal(decodeState(encodeState(reduce(initialView(), { type: 'select', id: 9 }))).selectedId, 9)
})

test('未知 action 原样返回，不产生新对象', () => {
  const s = initialView()
  assert.equal(reduce(s, { type: 'nope' }), s)
  assert.equal(reduce(s, undefined), s)
})
