import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, migrate, setCursor, getCursor, upsertSource, listSources,
  createRun, patchRun, finishRun, lastRun, candidates, setStatus, counts,
  getItemByKey, listItems, setSourceResult
} from '../lib/store.js'

const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
const row = (over = {}) => ({
  source_id: 's1', external_id: 'e1', kind: 'article', title: 't', url: 'https://e.com/1',
  author: null, author_id: null, published_at: 900, time_estimated: 0, fetched_at: 1000,
  thumb: null, duration_sec: null, stats_json: null, tags_json: null, locale: null,
  body_text: 'x', body_state: 'full', match_json: '{}', prefilter_score: 1, status: 'new', ...over
})
const insRow = (db, over) => db.prepare(`INSERT INTO items (
  source_id, external_id, kind, title, url, author, author_id, published_at, time_estimated, fetched_at,
  thumb, duration_sec, stats_json, tags_json, locale, body_text, body_state, match_json, prefilter_score, status
) VALUES (@source_id, @external_id, @kind, @title, @url, @author, @author_id, @published_at, @time_estimated, @fetched_at,
  @thumb, @duration_sec, @stats_json, @tags_json, @locale, @body_text, @body_state, @match_json, @prefilter_score, @status)`
).run(row(over))

test('游标按源存取，可覆盖，缺源返回 null', () => {
  const db = dbOf()
  assert.equal(getCursor(db, 's1'), null)
  setCursor(db, 's1', '2026-10-21T00:00:00.000Z')
  setCursor(db, 's1', '2026-10-22T00:00:00.000Z')
  assert.equal(getCursor(db, 's1'), '2026-10-22T00:00:00.000Z')
  assert.equal(getCursor(db, 's2'), null)
  db.close()
})

test('upsertSource 镜像配置但不覆盖运行态', () => {
  const db = dbOf()
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f', label: 'L', enabled: true, interval_min: 60, weight: 0.8 })
  setCursor(db, 's1', '2026-10-22T00:00:00.000Z')
  setSourceResult(db, 's1', { ok: true, at: 555 })
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f2', label: 'L2', enabled: false, interval_min: 120, weight: 1 })
  const [s] = listSources(db)
  assert.equal(s.url, 'https://e.com/f2')
  assert.equal(s.interval_min, 120)
  assert.equal(s.enabled, 0)
  assert.equal(getCursor(db, 's1'), '2026-10-22T00:00:00.000Z')
  assert.equal(s.last_ok_at, 555)
  db.close()
})

test('setSourceResult 失败时记录错误类别并保留上一次成功时间', () => {
  const db = dbOf()
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f' })
  setSourceResult(db, 's1', { ok: true, at: 100 })
  setSourceResult(db, 's1', { ok: false, error_class: 'timeout', error: '超过 20000ms 无响应', at: 200 })
  const [s] = listSources(db)
  assert.equal(s.last_error_class, 'timeout')
  assert.equal(s.last_ok_at, 100)
  db.close()
})

test('run 生命周期：create → patch → finish', () => {
  const db = dbOf()
  const id = createRun(db, 'manual', () => 1000)
  patchRun(db, id, { candidates: 3, per_source: { s1: { fetched: 3, ok: true } } })
  finishRun(db, id, { status: 'partial', error: 's2 超时' }, () => 2000)
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
  assert.equal(r.status, 'partial')
  assert.equal(r.candidates, 3)
  assert.equal(r.trigger, 'manual')
  assert.equal(r.started_at, 1000)
  assert.equal(r.finished_at, 2000)
  assert.equal(r.error, 's2 超时')
  assert.deepEqual(JSON.parse(r.per_source_json).s1, { fetched: 3, ok: true })
  assert.deepEqual(lastRun(db).id, id)
  db.close()
})

test('patchRun 忽略未知字段，不写脏列', () => {
  const db = dbOf()
  const id = createRun(db, 'manual', () => 1000)
  patchRun(db, id, { bogus: 'x', judged: 2 })
  assert.equal(db.prepare('SELECT judged FROM runs WHERE id=?').get(id).judged, 2)
  db.close()
})

test('candidates 只取 new，按 prefilter_score 降序、published_at 降序', () => {
  const db = dbOf()
  insRow(db, { external_id: 'a', prefilter_score: 1, published_at: 100 })
  insRow(db, { external_id: 'b', prefilter_score: 9, published_at: 90 })
  insRow(db, { external_id: 'c', prefilter_score: 9, published_at: 900 })
  insRow(db, { external_id: 'd', prefilter_score: 5, status: 'judged' })
  assert.deepEqual(candidates(db, 3).map(r => r.external_id), ['c', 'b', 'a'])
  assert.deepEqual(counts(db), { new: 3, judged: 1, digest: 0, archived: 0, total: 4 })
  db.close()
})

test('setStatus 写归档原因，且 null 不覆盖已有原因', () => {
  const db = dbOf()
  const { lastInsertRowid: id } = insRow(db, { external_id: 'x' })
  setStatus(db, id, 'archived', 'stale:20 天前')
  assert.equal(getItemByKey(db, 's1', 'x').archived_reason, 'stale:20 天前')
  setStatus(db, id, 'archived')
  assert.equal(getItemByKey(db, 's1', 'x').archived_reason, 'stale:20 天前')
  db.close()
})

test('listItems 支持 status / kind / tier 组合筛选与分页', () => {
  const db = dbOf()
  insRow(db, { external_id: '1', kind: 'article' })
  insRow(db, { external_id: '2', kind: 'video', duration_sec: 60 })
  const v = db.prepare("UPDATE items SET verdict_tier='值得看' WHERE external_id='2'")
  v.run()
  assert.deepEqual(listItems(db, { kind: 'video' }).map(r => r.external_id), ['2'])
  assert.deepEqual(listItems(db, { tier: '值得看' }).map(r => r.external_id), ['2'])
  assert.deepEqual(listItems(db, { status: 'archived' }), [])
  assert.equal(listItems(db, { limit: 1 }).length, 1)
  assert.equal(listItems(db, { limit: 1, offset: 1 }).length, 1)
  db.close()
})
