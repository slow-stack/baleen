import test from 'node:test'
import assert from 'node:assert/strict'
import { VideoView, visibleVideos, TIER_LABELS } from '../src/client/views/video.js'
import { fmtDuration } from '../src/client/format.js'
import { text, findAll } from './helpers/tree.mjs'

const mk = (over = {}) => ({
  id: 1, kind: 'video', title: 'DSH 插件怎么写', source_id: 'bili', author: '某人', duration_sec: 1102,
  body_state: 'subtitle', prefilter_score: 2, verdict_tier: null, status: 'new',
  match_json: '{"reason":"命中 DSH（AI 工具）"}', url: 'https://b23.tv/abc', ...over
})

const cardOf = (tree, id) => findAll(tree, 'bl-card').find((c) => c.props.key === id)

test('档位只有三个词，未判的显示"待判"而不是空白', () => {
  assert.deepEqual(Object.keys(TIER_LABELS).sort(), ['值得看', '可以看', '不值当'].sort())
  const card = cardOf(VideoView({ items: [mk()], filters: {}, state: { counts: { new: 1 } } }), 1)
  assert.match(text(card), /待判/)
  assert.doesNotMatch(text(card), /值得看|可以看|不值当/)
})

test('已判的条目显示档位徽章与判断理由', () => {
  const card = cardOf(VideoView({ items: [mk({ status: 'judged', verdict_tier: '值得看', verdict_why: '给了 loader 源码路径' })], filters: {} }), 1)
  assert.match(text(card), /值得看/)
  assert.match(text(card), /给了 loader 源码路径/)
})

test('按时长与状态标注：无语音与硬字幕分开说', () => {
  const a = text(cardOf(VideoView({ items: [mk({ body_state: 'missing' })], filters: {} }), 1))
  const b = text(cardOf(VideoView({ items: [mk({ body_state: 'burned_in' })], filters: {} }), 1))
  assert.match(a, /无语音/)
  assert.match(b, /硬字幕读不到/)
  assert.doesNotMatch(a, /硬字幕/)
})

test('筛选：tier / source / 关键词都生效，且是 AND', () => {
  const items = [mk({ id: 1, verdict_tier: '值得看', status: 'judged' }), mk({ id: 2, title: '少数派文章', source_id: 'sspai' })]
  assert.deepEqual(visibleVideos(items, { tier: '值得看' }).map(i => i.id), [1])
  assert.deepEqual(visibleVideos(items, { source: 'sspai' }).map(i => i.id), [2])
  assert.deepEqual(visibleVideos(items, { q: 'dsh' }).map(i => i.id), [1])
  assert.deepEqual(visibleVideos(items, { q: 'DSH', source: 'sspai' }), [])
})

test('非视频的条目不进视频区（图文笔记归文章区）', () => {
  assert.deepEqual(visibleVideos([mk({ id: 3, kind: 'note' }), mk({ id: 4, kind: 'article' })], {}).map(i => i.id), [])
})

test('时长显示 mm:ss，1 小时以上带小时', () => {
  assert.equal(fmtDuration(3723), '1:02:03')
  assert.equal(fmtDuration(75), '1:15')
  assert.equal(fmtDuration(0), '')
  assert.equal(fmtDuration('abc'), '')
  const t = text(VideoView({ items: [mk({ duration_sec: 3723 })], filters: {} }))
  assert.match(t, /1:02:03/)
})

// M4a 裁定：内嵌播放器 V5 才评估。卡片不许再许诺"可在抽屉内播"——
// 抽屉的能力边界同一时刻说的是"只能跳到浏览器里看"，两处各说各话就是谎。
test('暂无内嵌播放：B 站与其它平台都只给跳转，文案不假装能播', () => {
  const t = text(VideoView({ items: [mk({ source_id: 'bili' }), mk({ id: 9, source_id: 'xhs', external_id: 'x' })], filters: {} }))
  assert.match(t, /只能跳转/)
  assert.doesNotMatch(t, /可在抽屉内播/, '播放器还没定，卡片不许许诺抽屉内播')
})

// 档 A：封面是库里已有的 items.thumb，只是视图一直没读。占位灰块要换成真图，
// 但坏值（空、非字符串、非 http 协议）不许变成空 src 的裂图标——那比灰块更像 bug。
test('封面有真地址就画 <img>，时长徽章还在', () => {
  const card = cardOf(VideoView({ items: [mk({ thumb: 'https://i0.hdslb.com/bfs/archive/x.jpg' })], filters: {} }), 1)
  const thumb = findAll(card, 'bl-thumb')[0]
  const img = thumb.children.find((n) => n.type === 'img')
  assert.ok(img, '有 thumb 就该出 img')
  assert.equal(img.props.src, 'https://i0.hdslb.com/bfs/archive/x.jpg')
  assert.equal(img.props.alt, '', '封面是装饰，alt 留空不念两遍标题')
  assert.match(text(thumb), /18:22/, '时长徽章不能被图挤掉')
})

test('封面地址坏掉时退回灰占位，不画空 src 的图', () => {
  for (const bad of [null, undefined, '', '   ', 42, 'file:///c/x.jpg', 'javascript:alert(1)']) {
    const card = cardOf(VideoView({ items: [mk({ thumb: bad })], filters: {} }), 1)
    const thumb = findAll(card, 'bl-thumb')[0]
    assert.equal(thumb.children.some((n) => n.type === 'img'), false, '坏 thumb 不许画图：' + String(bad))
    assert.match(text(thumb), /18:22/)
  }
})

test('筛选后一条都不剩时，说的是"筛选太窄"而不是"库里没东西"', () => {
  const t = text(VideoView({ items: [mk()], filters: { tier: '不值当' } }))
  assert.match(t, /把筛选清一下/)
  assert.doesNotMatch(t, /还没有视频/)
})

test('工具条的每个控件都有 aria-label，筛选值从 filters 回填', () => {
  const tree = VideoView({ items: [mk()], filters: { tier: '可以看', source: 'bili', q: '插件' }, onFilter: () => {} })
  const sels = findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'select')
  assert.equal(sels.length, 2)
  assert.deepEqual(sels.map((s) => s.props['aria-label']), ['档位', '平台'])
  assert.equal(sels[0].props.value, '可以看')
  assert.equal(sels[1].props.value, 'bili')
  const input = findAll(tree, 'bl-toolbar')[0].children.find((n) => n.type === 'input')
  assert.equal(input.props.value, '插件')
})

test('改筛选带上视图名，别的视图的筛选不受影响', () => {
  const calls = []
  const tree = VideoView({ items: [mk()], filters: {}, onFilter: (a) => calls.push(a) })
  const sel = findAll(tree, 'bl-toolbar')[0].children.find((n) => n.type === 'select')
  sel.props.onChange({ target: { value: '值得看' } })
  assert.deepEqual(calls, [{ view: 'video', key: 'tier', value: '值得看' }])
})

test('排序按预筛得分高在前，得分缺失不至于乱序报错', () => {
  const items = [mk({ id: 1, prefilter_score: 1 }), mk({ id: 2, prefilter_score: 4 }), mk({ id: 3, prefilter_score: null })]
  assert.deepEqual(visibleVideos(items, {}).map(i => i.id), [2, 1, 3])
})
