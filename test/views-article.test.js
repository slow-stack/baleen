import test from 'node:test'
import assert from 'node:assert/strict'
import { ArticleView, currentArticle, visibleArticles, readableBody, readerParagraphs, STATE_HINT } from '../src/client/views/article.js'
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

/* ---------------- 右栏「抓取正文」（M8：摘要条目唯一的出路） ---------------- */

test('只有摘要时右栏有「抓取正文」按钮，点了把条目 id 回传出去', () => {
  const calls = []
  const tree = ArticleView({
    items: [mk({ id: 7, body_state: 'summary_only', body_text: '摘要一句话' })],
    filters: {}, selectedId: 7, onFulltext: (id) => calls.push(id)
  })
  const btn = findAll(tree, 'bl-fetch')[0]
  assert.ok(btn, '仅摘要时右栏必须给出抓取正文的入口')
  assert.equal(text(btn), '抓取正文')
  btn.props.onClick()
  assert.deepEqual(calls, [7], '面板只报条目 id，抓什么由宿主定')
})

test('抓取中按钮 disabled 且文案换成「正在抓取…」', () => {
  const tree = ArticleView({ items: [mk({ body_state: 'summary_only' })], filters: {}, selectedId: 1, fetching: true })
  const btn = findAll(tree, 'bl-fetch')[0]
  assert.equal(btn.props.disabled, true, '在途还能再点就是叠请求')
  assert.match(text(btn), /正在抓取/)
  assert.doesNotMatch(text(btn), /^抓取正文$/)
})

test('已经有正文（full/subtitle/transcribed）时不画这颗按钮：不给假动作', () => {
  for (const state of ['full', 'subtitle', 'transcribed']) {
    const tree = ArticleView({ items: [mk({ body_state: state })], filters: {}, selectedId: 1 })
    assert.equal(findAll(tree, 'bl-fetch').length, 0, state + ' 已经有正文，不该再给一颗点了也没用的按钮')
  }
  // missing / burned_in 是"真读不到"，这条出路要留着
  for (const state of ['missing', 'burned_in', 'summary_only']) {
    assert.equal(findAll(ArticleView({ items: [mk({ body_state: state })], filters: {}, selectedId: 1 }), 'bl-fetch').length, 1, state + ' 要给一次抓取的机会')
  }
})

test('仅摘要时多一行说明：抓不到就还是看原文，不让人以为插件坏了', () => {
  const t = text(ArticleView({ items: [mk({ body_state: 'summary_only' })], filters: {}, selectedId: 1 }))
  assert.match(t, /只拿到摘要/)
  assert.match(t, /抓不到就还是看原文/)
  // 这句是按钮的预期管理，别的时候不出现（尤其不能盖掉 full 的正文）
  const full = text(ArticleView({ items: [mk({ body_state: 'full' })], filters: {}, selectedId: 1 }))
  assert.doesNotMatch(full, /点上面的按钮去原文抓一次/)
})

test('currentArticle 与右栏画的同一条：选中项被筛掉时回落第一条', () => {
  const items = [mk({ id: 1 }), mk({ id: 2, source_id: 'b' })]
  assert.equal(currentArticle(items, {}, 2).id, 2)
  assert.equal(currentArticle(items, { source: 'b' }, 1).id, 2, '忙态贴错条目就是这里算岔了')
  assert.equal(currentArticle([], {}, 1), null)
})

test('阅读时长按分钟说，缺这个数就不写', () => {
  const tree = ArticleView({ items: [mk({ time_estimated: 12 })], filters: {}, selectedId: 1 })
  assert.match(text(findAll(tree, 'bl-reader')[0]), /约 12 分钟/)
  const none = ArticleView({ items: [mk({ time_estimated: 0 })], filters: {}, selectedId: 1 })
  assert.doesNotMatch(text(findAll(none, 'bl-reader')[0]), /约 \d+ 分钟/)
})

// 阅读排版（护眼）：空行成段、段内单换行保留——文章有段距，字幕逐行紧排，一条规则两边用
test('readerParagraphs 按空行分段，段内单换行原样保留', () => {
  const article = ['第一段。', '', '第二段第一行', '第二段第二行', '', '第三段。'].join('\n')
  assert.deepEqual(readerParagraphs(article), ['第一段。', '第二段第一行\n第二段第二行', '第三段。'],
    '空行才是段界，段内折行交给 pre-wrap')
  assert.deepEqual(readerParagraphs('00:01 你好\n00:04 世界'), ['00:01 你好\n00:04 世界'],
    '字幕行间只有单换行：整块一段，逐行紧排不拆散')
  assert.deepEqual(readerParagraphs('  \n\n  '), [], '纯空白不成段')
  assert.deepEqual(readerParagraphs(''), [])
  assert.deepEqual(readerParagraphs(null), [], '非字符串按空处理')
})

test('正文按段渲染成多个 p，空正文给占位句', () => {
  const tree = ArticleView({ items: [mk({ body_text: '第一段。\n\n第二段。' })], filters: {}, selectedId: 1 })
  const bodyNode = findAll(tree, 'bl-reader-body')[0]
  assert.equal(bodyNode.children.length, 2, '两个空行分段')
  assert.deepEqual(bodyNode.children.map((p) => p.children[0]), ['第一段。', '第二段。'])
  const empty = findAll(ArticleView({ items: [mk({ body_text: '' })], filters: {}, selectedId: 1 }), 'bl-reader-body')[0]
  assert.match(text(empty), /没有正文/)
})

test('CRLF 正文照常分段：Windows 作者的 feed 段界是 \r\n\r\n', () => {
  assert.deepEqual(readerParagraphs('第一段。\r\n\r\n第二段。'), ['第一段。', '第二段。'])
  assert.deepEqual(readerParagraphs('第一段。\r\r第二段。'), ['第一段。', '第二段。'], '老 Mac 的孤 \r 也归一')
  assert.deepEqual(readerParagraphs('行一\r\n行二'), ['行一\n行二'], '段内单换行归一后保留，pre-wrap 照常折行')
})
