import test from 'node:test'
import assert from 'node:assert/strict'
import { DigestView, digestEmptyReason, digestTime } from '../src/client/views/digest.js'
import { text, findAll } from './helpers/tree.mjs'

test('M3 没接入时不许用假总结充数', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0, last_run: { id: 1 } } }))
  assert.match(t, /判断轮（M3）尚未接入/)
  assert.doesNotMatch(t, /今日精选|编辑推荐|值得看 3 条/)
})

test('有待判条目时空态也要告诉你能干什么', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 4 }, digest_count: 0, last_run: { id: 1 } } }))
  assert.match(t, /待判 4/)
})

test('一条都没跑过时说的是"还没跑过"，不是"判断轮没接入"', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 0 }, digest_count: 0, last_run: null } }))
  assert.match(t, /还没跑过/)
  assert.doesNotMatch(t, /判断轮（M3）尚未接入/)
})

test('有汇报时按时间倒序列出，每份都带着它那一轮的落点', () => {
  const ds = [
    { id: 2, created_at: 2000, headline: '第二天的简报', markdown_path: 'digests/2.md' },
    { id: 1, created_at: 1000, headline: '第一天的简报', markdown_path: null }
  ]
  const tree = DigestView({ digests: ds, state: { counts: { new: 0 }, digest_count: 2 } })
  const t = text(tree)
  assert.ok(t.indexOf('第二天') < t.indexOf('第一天'), '顺序反了')
  assert.match(t, /digests\/2\.md/)
  assert.match(t, /（未落文件）/)
  assert.equal(findAll(tree, 'bl-dsum').length, 2)
})

test('计数说有 N 份但读不到内容时，明写没接上而不是画个空壳', () => {
  const t = text(DigestView({ digests: [], state: { counts: { new: 0 }, digest_count: 3, last_run: { id: 1 } } }))
  assert.match(t, /3 份/)
  assert.match(t, /还没接上/)
  assert.doesNotMatch(t, /判断轮（M3）尚未接入/)
})

test('空态原因函数按"手里有没有内容"分四种情况说话', () => {
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 0 }, last_run: null }, 0), /还没跑过/)
  assert.match(digestEmptyReason({ digest_count: 0, counts: { new: 5 }, last_run: { id: 1 } }, 0), /判断轮（M3）尚未接入/)
  assert.match(digestEmptyReason({ digest_count: 2, counts: { new: 0 }, last_run: { id: 1 } }, 0), /2 份/)
  assert.equal(digestEmptyReason({ digest_count: 2, counts: { new: 0 }, last_run: { id: 1 } }, 2), '')
})

test('时间按本地时区格式化，坏值不炸', () => {
  assert.equal(typeof digestTime(1000), 'string')
  assert.match(digestTime(null), /时间未知/)
  assert.match(digestTime('abc'), /时间未知/)
})
