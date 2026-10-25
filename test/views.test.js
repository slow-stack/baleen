import test from 'node:test'
import assert from 'node:assert/strict'
import { TodayView, summaryLine, gapText, REASONS_READABLE } from '../src/client/views/today.js'
import { text, findAll } from './helpers/tree.mjs'

const DAY = 86400000
const now = Date.parse('2026-10-24T08:00:00Z')

const state = {
  counts: { new: 12, judged: 5, digest: 0, archived: 33, total: 50 },
  last_run: { id: 3, status: 'partial', at: now - 3600000, candidates: 12 },
  sources: [
    { id: 'xhs', ok: false, error_class: 'needs_login' },
    { id: 'cloudflare', ok: true, error_class: null }
  ],
  gaps: { by_reason: { 'no-match': 20, stale: 10, 'no-body': 3 }, kept_with_flag: { burned_in: 1 }, total_dropped: 33 },
  schedule: { windows: ['07:00-09:00'], max_per_run: 25 }
}
const items = [
  { id: 1, kind: 'video', title: '一条视频', source_id: 'bili', body_state: 'subtitle', prefilter_score: 3, match_json: '{"reason":"命中 DSH（AI 工具）"}', duration_sec: 1102 },
  { id: 2, kind: 'article', title: '一篇文章', source_id: 'substack', body_state: 'summary_only', prefilter_score: 2, match_json: '{"reason":"命中 治理（公共管理）"}' },
  { id: 3, kind: 'note', title: '图文笔记', source_id: 'xhs', body_state: 'full', prefilter_score: 1, match_json: '{"reason":"关注源"}' }
]

test('每个丢弃原因都有中文说法，面板不必自己猜', () => {
  assert.deepEqual(Object.keys(REASONS_READABLE).sort(),
    ['below-score', 'no-body', 'no-match', 'skip-kind', 'stale', 'theme-reject', 'too-short'].sort())
})

test('统计行说清过筛→候选→待判，不把待判说成已筛', () => {
  const line = summaryLine(state)
  assert.match(line, /过筛 50/)
  assert.match(line, /待判 12/)
  assert.match(line, /已判 5/)
  assert.doesNotMatch(line, /已筛 12/)
})

test('丢弃明细逐条可读，带标记的保留项单独出现', () => {
  const t = gapText(state.gaps)
  assert.match(t, /没命中主题 20/)
  assert.match(t, /超龄 10/)
  assert.match(t, /读不到内容 3/)
  assert.match(t, /保留待读：硬字幕读不到 1/)
})

test('空态不谎报：没有一轮记录时写"还没有一轮记录"', () => {
  assert.equal(gapText(undefined), '（还没有一轮记录）')
  assert.equal(gapText({ by_reason: {}, kept_with_flag: {}, total_dropped: 0 }), '（还没有一轮记录）')
  const t = text(TodayView({ state: { counts: { new: 0, total: 0 }, sources: [] }, items: [] }))
  assert.match(t, /还没有跑过一轮/)
})

test('因收藏豁免的条目进「收藏钉住」桶：豁免不等于没有一轮记录', () => {
  const t = gapText({ by_reason: {}, kept_with_flag: {}, total_dropped: 0, held: 2 })
  assert.match(t, /收藏钉住 2/)
  assert.notEqual(t, '（还没有一轮记录）', '跑了一轮、有条目被豁免，面板不能说还没有一轮记录')
  // 与其他成分同排出现，chip 排在「保留待读」之后
  const mixed = gapText({ by_reason: { stale: 4 }, kept_with_flag: { burned_in: 1 }, total_dropped: 4, held: 3 })
  assert.match(mixed, /保留待读：硬字幕读不到 1 · 收藏钉住 3/)
})

test('held 为 0 或缺省时不出现收藏钉住，输出与现状逐字一致', () => {
  assert.equal(gapText({ by_reason: {}, kept_with_flag: {}, total_dropped: 0, held: 0 }), '（还没有一轮记录）')
  assert.equal(gapText({ by_reason: { stale: 4 }, kept_with_flag: {}, total_dropped: 4 }), '丢弃 4 · 超龄 4')
  assert.equal(gapText({ by_reason: { stale: 4 }, kept_with_flag: {}, total_dropped: 4, held: 0 }), '丢弃 4 · 超龄 4')
})

test('挂掉的源用文字说明原因，不是一个小圆点让人猜', () => {
  const t = text(TodayView({ state, items, onOpen: () => {} }))
  assert.match(t, /xhs 需要重新登录/)
  assert.doesNotMatch(t, /cloudflare 本轮失败/)   // 好的源不该出现在问题列表里
})

test('失败源的措辞带上"游标没推进，下轮自动补"', () => {
  const t = text(TodayView({ state: { ...state, sources: [{ id: 'blog', ok: false, error_class: 'timeout' }] }, items }))
  assert.match(t, /blog 本轮失败（timeout），游标没推进，下轮自动补/)
})

test('图文笔记进文章区，视频进视频区（按 kind 不按来源）', () => {
  const tree = TodayView({ state, items })
  const rails = findAll(tree, 'bl-rail')
  assert.equal(rails.length, 2)
  assert.match(text(rails[0]), /一条视频/)
  assert.doesNotMatch(text(rails[0]), /图文笔记/)
  assert.match(text(rails[1]), /图文笔记/)
  assert.match(text(rails[1]), /一篇文章/)
})

test('卡片必须有命中理由，缺理由写"（无理由）"而不是留空', () => {
  const cards = findAll(TodayView({ state, items: [{ ...items[0], match_json: '{}' }] }), 'bl-card')
  assert.equal(cards.length, 1)
  assert.match(text(cards[0]), /（无理由）/)
  const withReason = findAll(TodayView({ state, items: [items[0]] }), 'bl-card')
  assert.match(text(withReason[0]), /命中 DSH（AI 工具）/)
})

test('坏 match_json 不炸渲染', () => {
  const t = text(TodayView({ state, items: [{ ...items[0], match_json: '{坏掉的' }] }))
  assert.match(t, /（无理由）/)
})

test('未判条目在卡片上显示"待判"，不显示成已判', () => {
  const t = text(TodayView({ state, items: [items[0]] }))
  assert.match(t, /待判/)
})

test('空库时两个区各说各的话，不画假卡片', () => {
  const t = text(TodayView({ state: { ...state, counts: { new: 0, total: 0 }, gaps: { by_reason: {}, total_dropped: 0 } }, items: [] }))
  assert.match(t, /B 站 /)
  assert.match(t, /文章区是空的/)
  assert.equal(findAll(TodayView({ state: { ...state, counts: { new: 0, total: 0 } }, items: [] }), 'bl-card').length, 0)
})

test('今天卡片上的时长也是 mm:ss，不是裸秒数', () => {
  const card = findAll(TodayView({ state, items: [{ ...items[0], duration_sec: 3723 }] }), 'bl-card')[0]
  assert.match(text(card), /1:02:03/)
  assert.doesNotMatch(text(card), /3723/)
})

test('待判提示兑现 M3 承诺：不说"以后会自动提示"，直接告诉会话该说什么', () => {
  const t = text(TodayView({ state, items }))
  assert.match(t, /待判 12 条——判断由会话来做/)
  assert.match(t, /对会话说一句「把今天的候选判一下」/)
  assert.doesNotMatch(t, /自动提示/)
})

test('跑一轮按钮在忙时禁用，避免叠轮', () => {
  const tree = TodayView({ state, items, busy: true })
  const btns = findAll(tree, 'bl-actions')[0].children[0]
  assert.equal(btns.props.disabled, true)
  assert.equal(btns.children[0], '跑着…')
})
