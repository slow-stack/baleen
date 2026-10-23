import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, migrate, getItemByKey } from '../lib/store.js'
import { putDraft, findDuplicate } from '../lib/dedup.js'

const DAY = 86400000
const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
const draft = (over = {}) => ({
  source_id: 's1', external_id: 'g1', kind: 'article', title: '为什么 RSS 还活着',
  url: 'https://e.com/a?utm_source=x', author: '桉', author_id: null,
  published_at: 1000, time_estimated: 0, fetched_at: 2000, thumb: null, duration_sec: null,
  stats_json: null, tags_json: null, locale: null, body_text: '旧', body_state: 'full',
  match_json: '{}', prefilter_score: 1, status: 'new', ...over
})

test('唯一键命中且已判过 → skip_seen，不重复消耗判断预算', () => {
  const db = dbOf()
  const a = putDraft(db, draft(), () => 2000)
  assert.equal(a.action, 'insert')
  db.prepare("UPDATE items SET status='judged', verdict_tier='值得看' WHERE id=?").run(a.id)
  const b = putDraft(db, draft({ body_text: '更完整的一版' }), () => 3000)
  assert.equal(b.action, 'skip_seen')
  assert.equal(b.id, a.id)
  assert.equal(getItemByKey(db, 's1', 'g1').body_text, '旧')
  assert.equal(getItemByKey(db, 's1', 'g1').verdict_tier, '值得看')
  db.close()
})

test('唯一键命中但仍是 new → update，正文与得分刷新', () => {
  const db = dbOf()
  const a = putDraft(db, draft({ body_text: '旧' }), () => 2000)
  const b = putDraft(db, draft({ body_text: '新', prefilter_score: 3, fetched_at: 3000 }), () => 3000)
  assert.equal(b.action, 'update')
  assert.equal(b.id, a.id)
  const row = getItemByKey(db, 's1', 'g1')
  assert.equal(row.body_text, '新')
  assert.equal(row.prefilter_score, 3)
  assert.equal(row.fetched_at, 3000)
  db.close()
})

test('同一条 feed 里 guid 变了但 URL 是同一篇 → 新的记 duplicate 并归档', () => {
  const db = dbOf()
  const a = putDraft(db, draft({ external_id: 'g1' }), () => 2000)
  assert.equal(getItemByKey(db, 's1', 'g1').url, 'https://e.com/a')   // utm 在写库前就被归一化
  const b = putDraft(db, draft({ external_id: 'g2', url: 'https://e.com/a?utm_source=y' }), () => 2000 + DAY)
  assert.equal(b.action, 'duplicate')
  assert.notEqual(b.id, a.id)
  const dup = getItemByKey(db, 's1', 'g2')
  assert.equal(dup.status, 'archived')
  assert.match(dup.archived_reason, /^duplicate:url:https:\/\/e\.com\/a$/)
  db.close()
})

test('跨源转载在 14 天内算 duplicate，超窗就不算', () => {
  const db = dbOf()
  putDraft(db, draft({ source_id: 's1' }), () => 2000)
  const late = putDraft(db, draft({ source_id: 's2', external_id: 'z', url: 'https://other.com/a', fetched_at: 2000 + 15 * DAY }), () => 2000 + 15 * DAY)
  assert.equal(late.action, 'insert')
  const near = putDraft(db, draft({ source_id: 's3', external_id: 'z2', url: 'https://other.com/a?v=2', fetched_at: 2000 + 15 * DAY + 1 }), () => 2000 + 15 * DAY + 1)
  assert.equal(near.action, 'duplicate')
  assert.equal(getItemByKey(db, 's3', 'z2').url, 'https://other.com/a?v=2')   // 非跟踪参数保留
  db.close()
})

test('标题相同作者相同但 URL 不同也算 duplicate（feed 换域名的常见情形）', () => {
  const db = dbOf()
  putDraft(db, draft(), () => 2000)
  const b = putDraft(db, draft({ external_id: 'g9', url: 'https://mirror.example/a', title: '为什么 RSS 还活着？' }), () => 2000 + 60000)
  assert.equal(b.action, 'duplicate')
  db.close()
})

test('短标题不参与标题查重，避免把"教程"这种词误伤成一片', () => {
  const db = dbOf()
  putDraft(db, draft({ title: '教程', url: 'https://e.com/1', external_id: 't1' }), () => 2000)
  const b = putDraft(db, draft({ title: '教程', url: 'https://e.com/2', external_id: 't2' }), () => 2000 + 1)
  assert.equal(b.action, 'insert')
  db.close()
})

test('没有 URL 也没有标题时不判重（宁可重复也不误吞）', () => {
  const db = dbOf()
  const a = putDraft(db, draft({ title: '', url: 'https://e.com/x', external_id: 'x1' }), () => 2000)
  const b = putDraft(db, draft({ title: '', url: 'https://e.com/y', external_id: 'x2' }), () => 2000)
  assert.equal(a.action, 'insert')
  assert.equal(b.action, 'insert')
  assert.equal(findDuplicate(db, draft({ title: '', url: '', external_id: 'x3' }), () => 2000), null)
  db.close()
})

test('已因别的理由归档过的条目，再次抓到不重开', () => {
  const db = dbOf()
  const a = putDraft(db, draft(), () => 2000)
  db.prepare("UPDATE items SET status='archived', archived_reason='stale:20 天前' WHERE id=?").run(a.id)
  const b = putDraft(db, draft(), () => 3000)
  assert.equal(b.action, 'skip_seen')
  assert.match(b.reason, /archived:stale/)
  assert.equal(getItemByKey(db, 's1', 'g1').status, 'archived')
  db.close()
})

test('因为 duplicate 归档的那条，同键再抓时可以复活成 new', () => {
  const db = dbOf()
  const a = putDraft(db, draft(), () => 2000)
  db.prepare("UPDATE items SET status='archived', archived_reason='duplicate:url:x' WHERE id=?").run(a.id)
  const b = putDraft(db, draft({ body_text: '补到全文' }), () => 3000)
  assert.equal(b.action, 'update')
  assert.equal(getItemByKey(db, 's1', 'g1').status, 'new')
  db.close()
})
