import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbFile } from './paths.js'

const DDL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', 'items.sql'),
  'utf8'
)

/**
 * 打开库。传 ':memory:' 得到内存库（测试用）；传文件路径会自动建父目录。
 * 不传则用插件家目录下的 baleen.sqlite。
 */
export function openStore(file) {
  const target = file ?? dbFile()
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true })
  const db = new DatabaseSync(target)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  return { db, file: target, close: () => db.close() }
}

export function migrate(db) {
  db.exec(DDL)
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}

/* ---------------- 游标与源 ---------------- */

export function getCursor(db, sourceId) { return getMeta(db, `cursor:${sourceId}`) }
export function setCursor(db, sourceId, iso) { setMeta(db, `cursor:${sourceId}`, iso) }

export function upsertSource(db, s) {
  db.prepare(`INSERT INTO sources (id, type, url, label, enabled, interval_min, weight)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, url = excluded.url, label = excluded.label,
      enabled = excluded.enabled, interval_min = excluded.interval_min, weight = excluded.weight`)
    .run(s.id, s.type, s.url ?? null, s.label ?? null, s.enabled === false ? 0 : 1, s.interval_min ?? 720, s.weight ?? 1.0)
}

export function listSources(db) {
  return db.prepare('SELECT * FROM sources ORDER BY id').all()
}

/** 成功时只更新 last_ok_at 并清空错误；失败时保留 last_ok_at（它是"上次真的成功过"的证据） */
export function setSourceResult(db, id, { ok, error_class = null, error = null, at }) {
  db.prepare(`UPDATE sources SET last_error_class = ?, last_error = ?, last_ok_at = COALESCE(?, last_ok_at) WHERE id = ?`)
    .run(ok ? null : error_class, ok ? null : error, ok ? at : null, id)
}

/* ---------------- 条目 ---------------- */

const ITEM_COLS = `id, source_id, external_id, kind, title, url, author, author_id, published_at,
  time_estimated, fetched_at, thumb, duration_sec, tags_json, body_state, body_text, match_json,
  prefilter_score, title_norm, status, archived_reason, verdict_tier, verdict_why, feedback, seen_at`

const ITEM_DEFAULTS = {
  author: null, author_id: null, published_at: null, time_estimated: 0, thumb: null,
  duration_sec: null, stats_json: null, tags_json: null, locale: null, body_text: null,
  match_json: '{}', prefilter_score: 0, status: 'new', title_norm: null
}

export function insertItem(db, draft) {
  const row = { ...ITEM_DEFAULTS, ...draft }
  const r = db.prepare(`INSERT INTO items (
    source_id, external_id, kind, title, url, author, author_id, published_at, time_estimated, fetched_at,
    thumb, duration_sec, stats_json, tags_json, locale, body_text, body_state, match_json, prefilter_score, status, title_norm
  ) VALUES (@source_id, @external_id, @kind, @title, @url, @author, @author_id, @published_at, @time_estimated, @fetched_at,
    @thumb, @duration_sec, @stats_json, @tags_json, @locale, @body_text, @body_state, @match_json, @prefilter_score, @status, @title_norm)`
  ).run(row)
  return Number(r.lastInsertRowid)
}

export function getItemByKey(db, sourceId, externalId) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE source_id = ? AND external_id = ?`).get(sourceId, externalId) ?? null
}

export function getItemById(db, id) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).get(id) ?? null
}

export function findByUrl(db, url, sinceMs) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE url = ? AND fetched_at >= ? ORDER BY id ASC LIMIT 1`).get(url, sinceMs) ?? null
}

export function findByTitleNorm(db, titleNorm, sinceMs, author = null) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items
    WHERE title_norm = ? AND fetched_at >= ? AND ifnull(author, '') = ifnull(?, '')
    ORDER BY id ASC LIMIT 1`).get(titleNorm, sinceMs, author) ?? null
}

export function setStatus(db, id, status, reason = null) {
  db.prepare('UPDATE items SET status = ?, archived_reason = COALESCE(?, archived_reason) WHERE id = ?').run(status, reason, id)
}

const REFRESHABLE = ['body_text', 'body_state', 'match_json', 'prefilter_score', 'fetched_at', 'thumb',
  'published_at', 'time_estimated', 'tags_json', 'stats_json', 'title_norm', 'duration_sec', 'locale', 'author', 'url']

/** 只允许刷新这些列——status 由调用方单独决定，避免顺手把归档条目改回 new */
export function refreshItem(db, id, patch, status = null) {
  const sets = []
  const vals = []
  for (const col of REFRESHABLE) {
    if (patch[col] === undefined) continue
    sets.push(`${col} = ?`)
    vals.push(patch[col])
  }
  if (status) { sets.push('status = ?'); vals.push(status) }
  if (!sets.length) return
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function candidates(db, limit) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE status = 'new'
    ORDER BY prefilter_score DESC, published_at DESC, id ASC LIMIT ?`).all(limit)
}

export function counts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all()
  const out = { new: 0, judged: 0, digest: 0, archived: 0, total: 0 }
  for (const r of rows) {
    if (r.status in out) out[r.status] = r.n
    out.total += r.n
  }
  return out
}

export function listItems(db, { status = null, kind = null, tier = null, since = null, limit = 100, offset = 0 } = {}) {
  const where = []
  const vals = []
  if (status) { where.push('status = ?'); vals.push(status) }
  if (kind) { where.push('kind = ?'); vals.push(kind) }
  if (tier) { where.push('verdict_tier = ?'); vals.push(tier) }
  if (since) { where.push('fetched_at >= ?'); vals.push(since) }
  return db.prepare(`SELECT ${ITEM_COLS} FROM items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY fetched_at DESC, id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
}

/* ---------------- 轮次 ---------------- */

export function createRun(db, trigger, now = Date.now) {
  const r = db.prepare("INSERT INTO runs (started_at, trigger, status) VALUES (?, ?, 'running')").run(now(), trigger)
  return Number(r.lastInsertRowid)
}

const RUN_COLS = { candidates: 'candidates', judged: 'judged', per_source: 'per_source_json', model_run_id: 'model_run_id', error: 'error', status: 'status' }

export function patchRun(db, runId, patch) {
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch)) {
    const col = RUN_COLS[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    vals.push(k === 'per_source' ? JSON.stringify(v ?? {}) : v)
  }
  if (!sets.length) return
  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, runId)
}

export function finishRun(db, runId, patch = {}, now = Date.now) {
  patchRun(db, runId, patch)
  db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(patch.status ?? 'done', now(), runId)
}

export function lastRun(db) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null
}
