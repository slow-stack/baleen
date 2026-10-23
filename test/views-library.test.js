import test from 'node:test'
import assert from 'node:assert/strict'
import { LibraryView, libraryRows, FACETS } from '../src/client/views/library.js'
import { text, findAll } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'article', source_id: 'a', title: 'T1', status: 'new', body_state: 'full',
  verdict_tier: null, published_at: 1000, prefilter_score: 1, match_json: '{}', ...over
})
const items = [
  mk({ id: 1 }),
  mk({ id: 2, kind: 'video', source_id: 'b', status: 'judged', verdict_tier: '不值当', title: '盘点来了', duration_sec: 400 }),
  mk({ id: 3, status: 'archived', title: '旧的', archived_reason: 'stale:20 天前' })
]
const box = (tree, facet, value) => findAll(tree, 'bl-facet')
  .find((f) => f.props['data-facet'] === facet)
  .children.find((n) => n.type === 'label' && n.children[1] === value).children[0]

test('facet 是"多选"：空数组=不筛，多值是 OR，facet 之间是 AND', () => {
  assert.deepEqual(libraryRows(items, {}).map(i => i.id), [1, 2, 3])
  assert.deepEqual(libraryRows(items, { status: ['judged'] }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { status: ['new', 'archived'] }).map(i => i.id), [1, 3])
  assert.deepEqual(libraryRows(items, { kind: ['video'] }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { tier: ['不值当'] }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { source: ['b'] }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { status: ['judged', 'archived'], kind: ['video'] }).map(i => i.id), [2])
  assert.deepEqual(libraryRows(items, { status: ['judged'], tier: ['值得看'] }), [])
})

test('四组 facet 都在，且未判的条目不会被档位筛选吃掉却也没有"未判"这一档', () => {
  assert.deepEqual(FACETS.map(f => f.key), ['status', 'kind', 'tier', 'source'])
  assert.deepEqual(FACETS.find(f => f.key === 'tier').options, ['值得看', '可以看', '不值当'])
  assert.deepEqual(FACETS.find(f => f.key === 'status').options, ['new', 'judged', 'digest', 'archived'])
})

test('facet 的勾选状态从 filters 回填', () => {
  const tree = LibraryView({ items, filters: { status: ['judged'], kind: [] } })
  assert.equal(box(tree, 'status', 'judged').props.checked, true)
  assert.equal(box(tree, 'status', 'new').props.checked, false)
  assert.equal(box(tree, 'kind', 'article').props.checked, false)
})

test('勾一下发的是 facet 动作，带上视图名与 on/off', () => {
  const calls = []
  const tree = LibraryView({ items, filters: {}, onFacet: (a) => calls.push(a) })
  box(tree, 'status', 'archived').props.onChange({ target: { checked: true } })
  box(tree, 'kind', 'video').props.onChange({ target: { checked: false } })
  assert.deepEqual(calls, [
    { view: 'library', key: 'status', value: 'archived', on: true },
    { view: 'library', key: 'kind', value: 'video', on: false }
  ])
})

test('来源 facet 的选项来自实际数据，不是写死的四个平台名', () => {
  const tree = LibraryView({ items, filters: {} })
  const opts = findAll(tree, 'bl-facet').find(f => f.props['data-facet'] === 'source')
    .children.filter(n => n.type === 'label').map(c => c.children[1])
  assert.deepEqual(opts, ['a', 'b'])
})

test('已判过的条目说清改判归谁做，不放假的改判按钮', () => {
  const t = text(LibraryView({ items, filters: { status: ['judged'] } }))
  assert.match(t, /改判/)
  assert.match(t, /save_verdicts/)
  assert.doesNotMatch(t, /改判一下|撤销判断/)
})

test('批量归档只是入口，没有真动作时标未接入而不是假装可用', () => {
  const t = text(LibraryView({ items, filters: {} }))
  assert.match(t, /批量归档（M3）尚未接入/)
})

test('一屏只放 100 条，剩下的说还有多少', () => {
  const many = Array.from({ length: 130 }, (_, i) => mk({ id: i + 1, title: 'T' + (i + 1) }))
  const tree = LibraryView({ items: many, filters: {} })
  assert.equal(findAll(tree, 'bl-card').length, 100)
  assert.match(text(tree), /还有 30 条/)
})

test('点一行是开抽屉（库没有右栏正文）', () => {
  const opened = []
  const tree = LibraryView({ items, filters: {}, onOpen: (id) => opened.push(id) })
  findAll(tree, 'bl-card')[0].props.onClick()
  assert.deepEqual(opened, [1])
})

test('空库与"筛到 0 条"两种空态说法不同', () => {
  const empty = text(LibraryView({ items: [], filters: {} }))
  assert.match(empty, /库里还没有条目/)
  const narrowed = text(LibraryView({ items, filters: { tier: ['值得看'] } }))
  assert.match(narrowed, /0 条/)
  assert.match(narrowed, /把勾选清一下/)
})

test('归档条目在库里看得见归档原因，不会凭空消失', () => {
  const tree = LibraryView({ items, filters: { status: ['archived'] } })
  assert.match(text(findAll(tree, 'bl-card')[0]), /stale:20 天前/)
})
