import test from 'node:test'
import assert from 'node:assert/strict'
import { DigestView, digestEmptyReason, digestTierLine } from '../src/client/views/digest.js'
import { fmtTime } from '../src/client/format.js'
import { text, findAll } from './helpers/tree.mjs'

test('接入了但还没判过时，不许用假总结充数，也不许再说"尚未接入"', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0, last_run: { id: 1 } } }))
  assert.match(t, /判断轮已接入，但还没有跑过判断/)
  assert.match(t, /对会话说一句「把今天的候选判一下」/)
  assert.doesNotMatch(t, /尚未接入/)
  assert.doesNotMatch(t, /今日精选|编辑推荐|值得看 3 条/)
})

test('有待判条目时空态也要点出还有多少条在等', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0, last_run: { id: 1 } } }))
  assert.match(t, /待判 4/)
})

test('一条都没跑过时说的是"还没跑过"，不是"接入了但没判"', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 0 }, digest_count: 0, last_run: null } }))
  assert.match(t, /还没跑过/)
  assert.doesNotMatch(t, /判断轮已接入/)
})

test('有汇报时按时间倒序列出，每份带 tiers 计数（latestDigests 只有四列，没有原文路径可展示）', () => {
  const ds = [
    { id: 2, created_at: 2000, headline: '判了 2 条：值得看 1 · 可以看 0 · 不值当 1',
      stats: { judged: 2, tiers: { '值得看': 1, '可以看': 0, '不值当': 1 }, at: 2000 } },
    { id: 1, created_at: 1000, headline: '第一天的简报', stats: null }
  ]
  const tree = DigestView({ digests: ds, state: { counts: { new: 0 }, digest_count: 2 } })
  const t = text(tree)
  assert.ok(t.indexOf('判了 2 条') < t.indexOf('第一天的简报'), '顺序反了')
  assert.match(t, /值得看 1 · 可以看 0 · 不值当 1/)
  assert.match(t, /（这份汇报的计数没读出来）/)
  assert.equal(findAll(tree, 'bl-dsum').length, 2)
})

test('计数说有 N 份但读不到内容时，明写没读到而不是画个空壳', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 0 }, digest_count: 3, last_run: { id: 1 } } }))
  assert.match(t, /3 份/)
  assert.match(t, /没读到/)
  assert.doesNotMatch(t, /判断轮已接入/, '"读不到"那一支不许混进"还没判"的话术')
})

test('空态原因函数按"手里有没有内容"分四种情况说话', () => {
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 0 }, last_run: null }, 0), /还没跑过/)
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 5 }, last_run: { id: 1 } }, 0), /判断轮已接入/)
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 5 }, last_run: { id: 1 } }, 0), /待判 5/)
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 0 }, last_run: { id: 1 } }, 0), /判断轮已接入/)
  assert.match(digestEmptyReason({ digest_count: 2, counts: { new: 0 }, last_run: { id: 1 } }, 0), /2 份/)
  assert.equal(digestEmptyReason({ digest_count: 2, counts: { new: 0 }, last_run: { id: 1 } }, 2), '')
})

test('tiers 计数行：数字来自 stats.tiers；缺计数明说没读到，不装作没有', () => {
  assert.equal(digestTierLine(null), '（这份汇报的计数没读出来）')
  assert.equal(digestTierLine({ judged: 2 }), '（这份汇报的计数没读出来）')
  assert.equal(digestTierLine({ judged: 2, tiers: { '值得看': 1, '可以看': 0, '不值当': 1 } }), '值得看 1 · 可以看 0 · 不值当 1')
})

test('时间按本地时区格式化，坏值不炸', () => {
  assert.equal(typeof fmtTime(1000), 'string')
  assert.match(fmtTime(null), /时间未知/)
  assert.match(fmtTime('abc'), /时间未知/)
})
