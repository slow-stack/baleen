import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, REASONS, summarizeGaps } from '../lib/prefilter.js'

const DAY = 86400000
const pref = { limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] }, min_score: 0.2 }
const d = (over = {}) => ({
  kind: 'article', body_state: 'full', duration_sec: null, published_at: 1000,
  prefilter_score: 1, match_json: '{"rejected":false}', ...over
})

test('丢弃原因固定可枚举，面板和汇报都能直接按它出统计', () => {
  assert.deepEqual(REASONS, ['theme-reject', 'no-body', 'stale', 'too-short', 'skip-kind', 'below-score'])
})

test('主题 never 命中 → theme-reject，并把命中的那个词带在明细里', () => {
  const r = gate(d({ match_json: '{"rejected":true,"reason":"never「盘点合集」"}' }), pref, () => 2000)
  assert.deepEqual(r, { pass: false, reason: 'theme-reject', detail: 'never「盘点合集」' })
})

test('missing 丢弃、burned_in 保留并打标记——两者不能混为一谈', () => {
  assert.equal(gate(d({ body_state: 'missing' }), pref, () => 2000).reason, 'no-body')
  const b = gate(d({ body_state: 'burned_in' }), pref, () => 2000)
  assert.equal(b.pass, true)
  assert.equal(b.keep_flag, 'burned_in')
})

test('summary_only 放行：Medium 付费墙是常态，不是劣质', () => {
  assert.equal(gate(d({ body_state: 'summary_only' }), pref, () => 2000).pass, true)
})

test('超期丢弃，明细写清几天前', () => {
  const r = gate(d({ published_at: 0 }), pref, () => 20 * DAY)
  assert.equal(r.pass, false)
  assert.equal(r.reason, 'stale')
  assert.match(r.detail, /^20 天前$/)
})

test('短视频按 min_duration_sec 丢弃；文章没有时长不受影响', () => {
  assert.equal(gate(d({ kind: 'video', duration_sec: 30 }), pref, () => 2000).reason, 'too-short')
  assert.equal(gate(d({ kind: 'article', duration_sec: null }), pref, () => 2000).pass, true)
  assert.equal(gate(d({ kind: 'video', duration_sec: null }), pref, () => 2000).pass, true)
})

test('skip_kinds 与低分', () => {
  const p = { ...pref, limits: { ...pref.limits, skip_kinds: ['note'] } }
  assert.equal(gate(d({ kind: 'note' }), p, () => 2000).reason, 'skip-kind')
  assert.equal(gate(d({ prefilter_score: 0.01 }), pref, () => 2000).reason, 'below-score')
})

test('发布时间缺失不按过期处理（缺时间不等于很旧）', () => {
  assert.equal(gate(d({ published_at: null }), pref, () => 20 * DAY).pass, true)
})

test('偏好缺字段时用内置默认，而不是抛异常', () => {
  assert.equal(gate(d({ prefilter_score: 0 }), {}, () => 2000).reason, 'below-score')
  assert.equal(gate(d({}), undefined, () => 2000).pass, true)
})

test('坏 match_json 不炸，按未命中处理', () => {
  assert.equal(gate(d({ match_json: '{坏掉的' }), pref, () => 2000).pass, true)
})

test('归档统计能汇总成"读了多少、丢了多少、为什么丢"（汇报区靠这个诚实）', () => {
  const dropped = [
    { reason: 'no-body', detail: '读不到内容' },
    { reason: 'no-body', detail: '读不到内容' },
    { reason: 'burned_in', keep: true },
    { reason: 'stale', detail: '20 天前' },
    { reason: 'theme-reject', detail: 'never「盘点合集」' }
  ]
  const s = summarizeGaps(dropped)
  assert.equal(s.by_reason['no-body'], 2)
  assert.equal(s.by_reason.stale, 1)
  assert.equal(s.by_reason['theme-reject'], 1)
  assert.equal(s.kept_with_flag.burned_in, 1)
  assert.equal(s.total_dropped, 4)          // no-body ×2 + stale + theme-reject；burned_in 是保留不是丢弃
  assert.deepEqual(summarizeGaps([]), { by_reason: {}, kept_with_flag: {}, total_dropped: 0 })
})
