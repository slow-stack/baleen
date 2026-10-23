import test from 'node:test'
import assert from 'node:assert/strict'
import { ArticleView, visibleArticles, readableBody, STATE_HINT } from '../src/client/views/article.js'
import { text, findAll } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'article', title: '为什么 RSS 还活着', source_id: 'substack', author: 'A.L.',
  body_state: 'full', body_text: '正文一大段。'.repeat(40), summary_hint: '', status: 'new',
  match_json: '{"reason":"命中 治理（公共管理）"}', url: 'https://e.com/a', ...over
})
const rowOf = (tree, id) => findAll(tree, 'bl-row').find((n) => n.props.key === id)

test('图文笔记归文章区，视频不算', () => {
  const items = [mk({ id: 1 }), mk({ id: 2, kind: 'note', source_id: 'xhs', title: '政策过程笔记' }), mk({ id: 3, kind: 'video', duration_sec: 300 })]
  assert.deepEqual(visibleArticles(items, {}).map(i => i.id), [1, 2])
})

test('仅摘要要说清是"这个源只给摘要"，不是插件读不到', () => {
  const tree = ArticleView({ items: [mk({ body_state: 'summary_only', body_text: '摘要一句话' })], filters: {}, selectedId: 1 })
  const t = text(tree)
  assert.match(t, /这个源只给摘要/)
  assert.doesNotMatch(t, /读不到内容/)
  assert.match(t, /读原文/)
})

test('六种 body_state 各有说法，missing 与 burned_in 不合并', () => {
  assert.deepEqual(Object.keys(STATE_HINT).sort(), ['burned_in', 'full', 'missing', 'summary_only', 'subtitle', 'transcribed'].sort())
  assert.match(STATE_HINT.summary_only, /源只给摘要/)
  assert.match(STATE_HINT.missing, /读不到/)
  assert.match(STATE_HINT.burned_in, /硬字幕/)
  assert.equal(STATE_HINT.full, '')
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
  assert.deepEqual(visibleArticles(items, { q: 'rss' }).map(i => i.id), [1, 2])
  assert.deepEqual(visibleArticles(items, { q: '不存在的词' }), [])
})

test('左栏选中项由 selectedId 决定，没给就读第一条', () => {
  const items = [mk({ id: 1, title: '第一条' }), mk({ id: 2, title: '第二条' })]
  const tree = ArticleView({ items, filters: {}, selectedId: 2 })
  assert.match(text(findAll(tree, 'bl-reader')[0]), /第二条/)
  assert.equal(rowOf(tree, 2).props['aria-selected'], 'true')
  assert.equal(rowOf(tree, 1).props['aria-selected'], 'false')
  const def = ArticleView({ items, filters: {} })
  assert.match(text(findAll(def, 'bl-reader')[0]), /第一条/)
})

test('selectedId 指向一条被筛掉的条目时回落第一条，右栏不空白', () => {
  const items = [mk({ id: 1, title: '第一条' }), mk({ id: 2, source_id: 'b', title: '第二条' })]
  const tree = ArticleView({ items, filters: { source: 'b' }, selectedId: 1 })
  assert.equal(rowOf(tree, 1), undefined)
  assert.match(text(findAll(tree, 'bl-reader')[0]), /第二条/)
})

test('左栏为空时右栏说"筛选太窄或还没抓"，不画假正文', () => {
  const t = text(ArticleView({ items: [], filters: {} }))
  assert.match(t, /左边没有条目/)
  assert.doesNotMatch(t, /正文一大段/)
})

test('工具条三个控件带 aria-label 并回填 filters', () => {
  const tree = ArticleView({ items: [mk()], filters: { source: 'substack', state: 'full', q: 'rss' } })
  const bar = findAll(tree, 'bl-toolbar')[0]
  const ctrls = bar.children.filter((n) => n.type === 'select' || n.type === 'input')
  assert.deepEqual(ctrls.map((c) => c.props['aria-label']), ['来源', '正文', '关键词'])
  assert.deepEqual(ctrls.map((c) => c.props.value), ['substack', 'full', 'rss'])
})

test('改筛选带上视图名 article，与视频区的筛选互不干扰', () => {
  const calls = []
  const tree = ArticleView({ items: [mk()], filters: {}, onFilter: (a) => calls.push(a) })
  const sel = findAll(tree, 'bl-toolbar')[0].children.find((n) => n.type === 'select')
  sel.props.onChange({ target: { value: 'substack' } })
  assert.deepEqual(calls, [{ view: 'article', key: 'source', value: 'substack' }])
})

test('点左栏一行只换右栏（选中），不弹抽屉；抽屉从右栏的"详情与反馈"进', () => {
  const opened = []
  const selected = []
  const tree = ArticleView({ items: [mk()], filters: {}, onOpen: (id) => opened.push(id), onSelect: (id) => selected.push(id) })
  rowOf(tree, 1).props.onClick()
  assert.deepEqual(selected, [1])
  assert.deepEqual(opened, [])
  const detail = findAll(tree, 'bl-detail')[0]
  assert.ok(detail, '右栏要有进抽屉的入口，不然文章区没法反馈')
  detail.props.onClick()
  assert.deepEqual(opened, [1])
})

test('阅读时长按分钟说，缺这个数就不写', () => {
  const tree = ArticleView({ items: [mk({ time_estimated: 12 })], filters: {}, selectedId: 1 })
  assert.match(text(findAll(tree, 'bl-reader')[0]), /约 12 分钟/)
  const none = ArticleView({ items: [mk({ time_estimated: 0 })], filters: {}, selectedId: 1 })
  assert.doesNotMatch(text(findAll(none, 'bl-reader')[0]), /约 \d+ 分钟/)
})
