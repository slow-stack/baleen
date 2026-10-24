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

test('旧库补列是幂等的：先建无 gaps_json 的 runs，migrate 后能写能读', () => {
  const { db } = openStore(':memory:')
  db.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, finished_at INTEGER, trigger TEXT, status TEXT, candidates INTEGER DEFAULT 0, judged INTEGER DEFAULT 0, model_run_id TEXT, error TEXT, per_source_json TEXT)')
  assert.equal(db.prepare('PRAGMA table_info(runs)').all().some(r => r.name === 'gaps_json'), false)
  migrate(db)
  assert.equal(db.prepare('PRAGMA table_info(runs)').all().some(r => r.name === 'gaps_json'), true)
  migrate(db)   // 再跑一次不能报"列已存在"
  const id = createRun(db, 'manual', () => 1000)
  finishRun(db, id, { status: 'done', gaps: { by_reason: { stale: 3 }, kept_with_flag: { burned_in: 1 }, total_dropped: 3 } }, () => 2000)
  assert.deepEqual(JSON.parse(db.prepare('SELECT gaps_json FROM runs WHERE id=?').get(id).gaps_json).by_reason, { stale: 3 })
  db.close()
})

// f7fdfb8 往 DDL 里加了 max_age_days 却没配 PRAGMA/ALTER 回填：291d55d 或更早建的库
// 过得了 migrate（CREATE TABLE IF NOT EXISTS 整表 no-op），upsertSource 一写就炸
// "no column named max_age_days"——任何老库升级都会踩。列集考古自 git show 291d55d:lib/sql/items.sql。
test('老库补列：291d55d 时代的 sources 没有 max_age_days，migrate 后 upsertSource 能写', () => {
  const { db } = openStore(':memory:')
  db.exec(`CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    url TEXT,
    label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    interval_min INTEGER NOT NULL DEFAULT 720,
    weight REAL NOT NULL DEFAULT 1.0,
    cursor TEXT,
    last_error_class TEXT,
    last_error TEXT,
    last_ok_at INTEGER
  )`)
  assert.equal(db.prepare('PRAGMA table_info(sources)').all().some(r => r.name === 'max_age_days'), false)
  migrate(db)
  assert.equal(db.prepare('PRAGMA table_info(sources)').all().some(r => r.name === 'max_age_days'), true)
  migrate(db)   // 再跑一次不能报"列已存在"
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f', max_age_days: 30 })
  upsertSource(db, { id: 's2', type: 'rss', url: 'https://e.com/g' })
  const rows = listSources(db)
  assert.equal(rows.find(r => r.id === 's1').max_age_days, 30, '带的值要落库')
  assert.equal(rows.find(r => r.id === 's2').max_age_days, null, '不带的必须是 null，不许有假默认')
  // 补出来的列与 DDL 同型：可空 INTEGER、无默认——NOT NULL 会让有老行的表 ALTER 直接炸，
  // 带默认则把 null 说成假值，两种都算对覆盖面撒谎。
  const col = db.prepare('PRAGMA table_info(sources)').all().find(r => r.name === 'max_age_days')
  assert.equal(col.type, 'INTEGER')
  assert.equal(col.notnull, 0)
  assert.equal(col.dflt_value, null)
  db.close()
})

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

test('upsertSource 带上按源的过期窗，缺省为 null（用全局值）', () => {
  const db = dbOf()
  upsertSource(db, { id: 'slow', type: 'rss', url: 'https://e.com/f', max_age_days: 180 })
  upsertSource(db, { id: 'fast', type: 'rss', url: 'https://e.com/g' })
  const rows = listSources(db)
  assert.equal(rows.find(r => r.id === 'slow').max_age_days, 180)
  assert.equal(rows.find(r => r.id === 'fast').max_age_days, null)
  db.close()
})

test('listItems 的 status 能吃逗号串：面板要的"没归档"是三种状态一起', () => {
  const db = dbOf()
  insRow(db, { external_id: '1' })
  insRow(db, { external_id: '2', status: 'judged' })
  insRow(db, { external_id: '3', status: 'digest' })
  insRow(db, { external_id: '4', status: 'archived' })
  assert.deepEqual(listItems(db, { status: 'new,judged,digest' }).map(r => r.external_id).sort(), ['1', '2', '3'])
  assert.deepEqual(listItems(db, { status: ['new', 'digest'] }).map(r => r.external_id).sort(), ['1', '3'])
  assert.deepEqual(listItems(db, { status: 'new,judged,digest', kind: 'video' }).length, 0)
  assert.equal(listItems(db, { status: '' }).length, 4)       // 空串=不筛，不是"筛空"
  assert.equal(listItems(db, { status: 'archived' }).length, 1)
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
