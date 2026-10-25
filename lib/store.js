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

/**
 * 建表 + 幂等补列。库里可能已经存着上一版建的 runs（本机测试库就是），
 * 所以新加的列要用 PRAGMA 判断后 ALTER，不能只靠 IF NOT EXISTS。
 * items 的补列必须在 exec(DDL) 之前：DDL 里的 CREATE INDEX 引用了后加的列
 * （published_at、title_norm），老库缺列时 exec 会炸在 "no such column" 上，
 * 后面的 folders 表就永远建不出来。sources 的补列（max_age_days）并进同一块：
 * 老库过得了 CREATE TABLE IF NOT EXISTS（整表 no-op），却会在 upsertSource
 * 写入时炸 "no column named max_age_days"；表不存在（新库）时 PRAGMA 返回空集，
 * 靠 size 守卫跳过，列由 DDL 原样建全，别给新库 ALTER 出半个表。
 */
export function migrate(db) {
  const itemCols = new Set(db.prepare('PRAGMA table_info(items)').all().map((r) => r.name))
  if (itemCols.size) {
    if (!itemCols.has('published_at')) db.exec('ALTER TABLE items ADD COLUMN published_at INTEGER')
    if (!itemCols.has('title_norm')) db.exec('ALTER TABLE items ADD COLUMN title_norm TEXT')
  }
  const sourceCols = new Set(db.prepare('PRAGMA table_info(sources)').all().map((r) => r.name))
  if (sourceCols.size) {
    if (!sourceCols.has('max_age_days')) db.exec('ALTER TABLE sources ADD COLUMN max_age_days INTEGER')
  }
  db.exec(DDL)
  const runCols = new Set(db.prepare('PRAGMA table_info(runs)').all().map((r) => r.name))
  if (!runCols.has('gaps_json')) db.exec('ALTER TABLE runs ADD COLUMN gaps_json TEXT')
  // 默认夹是收藏功能的落点，必须"永远恰好一个"：只在缺席时补，不靠 UNIQUE 兜。
  // OR IGNORE 是 spec §3 的原文：库里可能已经有一个叫「默认」但 is_default=0 的夹（库外手术过），
  // 裸 INSERT 会撞 folders.name 的 UNIQUE 把整个 migrate 炸掉，IGNORE 让这一句安静跳过。
  if (!db.prepare('SELECT 1 FROM folders WHERE is_default = 1 LIMIT 1').get()) {
    db.prepare('INSERT OR IGNORE INTO folders (name, created_at, is_default) VALUES (?, ?, 1)')
      .run('默认', Date.now())
  }
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
  db.prepare(`INSERT INTO sources (id, type, url, label, enabled, interval_min, weight, max_age_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, url = excluded.url, label = excluded.label,
      enabled = excluded.enabled, interval_min = excluded.interval_min, weight = excluded.weight,
      max_age_days = excluded.max_age_days`)
    .run(s.id, s.type, s.url ?? null, s.label ?? null, s.enabled === false ? 0 : 1,
      s.interval_min ?? 720, s.weight ?? 1.0, Number.isInteger(s.max_age_days) ? s.max_age_days : null)
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

/**
 * 面板两个按钮的留痕：只记"用户对这条做过什么"，不影响任何排序或权重
 * （权重是 tuning 的事，由 bumpTuning 走偏好文件那条路）。
 */
export function markFeedback(db, id, feedback, at = Date.now) {
  db.prepare('UPDATE items SET feedback = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ?').run(feedback, at(), id)
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

export function listItems(db, { status = null, kind = null, tier = null, since = null, folder = null, limit = 100, offset = 0 } = {}) {
  const where = []
  const vals = []
  // status 允许 'new,judged,digest' 这种串：面板三个视图都要"没归档的"，
  // 靠多次请求拼不如一条 IN，也不会让归档条目吃掉限量名额。
  const statuses = (Array.isArray(status) ? status : String(status ?? '').split(','))
    .map((s) => String(s).trim()).filter(Boolean)
  if (statuses.length === 1) { where.push('status = ?'); vals.push(statuses[0]) }
  else if (statuses.length > 1) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    vals.push(...statuses)
  }
  if (kind) { where.push('kind = ?'); vals.push(kind) }
  if (tier) { where.push('verdict_tier = ?'); vals.push(tier) }
  if (since) { where.push('fetched_at >= ?'); vals.push(since) }
  // 收藏页取数：按夹走关系表。不带状态过滤——"我收过的不会凭空消失"是 D15 的承诺。
  if (folder != null && Number.isInteger(Number(folder))) {
    where.push('id IN (SELECT item_id FROM folder_items WHERE folder_id = ?)')
    vals.push(Number(folder))
  }
  return db.prepare(`SELECT ${ITEM_COLS} FROM items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY fetched_at DESC, id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
}

/* ---------------- 轮次 ---------------- */

export function createRun(db, trigger, now = Date.now) {
  const r = db.prepare("INSERT INTO runs (started_at, trigger, status) VALUES (?, ?, 'running')").run(now(), trigger)
  return Number(r.lastInsertRowid)
}

/**
 * 只认这张表有的列；`*_json` 列一律序列化——
 * 新加一个 JSON 列时只改这个集合，不要指望调用方记得自己 stringify（`gaps` 就这么炸过一次）。
 */
const RUN_COLS = { candidates: 'candidates', judged: 'judged', per_source: 'per_source_json', gaps: 'gaps_json', model_run_id: 'model_run_id', error: 'error', status: 'status' }
const RUN_JSON_COLS = new Set(['per_source_json', 'gaps_json'])

export function patchRun(db, runId, patch) {
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch)) {
    const col = RUN_COLS[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    vals.push(RUN_JSON_COLS.has(col) ? JSON.stringify(v ?? {}) : v)
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

/* ---------------- 判断与汇报 ---------------- */

/**
 * 三档词的单一真相源：saveVerdicts 的校验与工具面的参数 schema（lib/tools.js 的
 * tier 枚举）从这份清单取词；digest 的 headline 模板与 tiers 计数对象是字面量，
 * 不经过这里——改档位词时那两处要一起动。这是硬红线（AGENTS.md 第 6 条）：
 * 不许自创档位，不许写分数。
 */
export const VERDICT_TIERS = ['值得看', '可以看', '不值当']

/**
 * 判断落库。整批一个 SAVEPOINT，先做全部校验再进写循环（手法照抄 setItemFolders，
 * node:sqlite 没有 db.transaction() 的缘由也记在那边）：任何一条失败整批回滚——
 * "判了 3 条只落下 2 条"比全拒更难排查，所以校验期根本不碰写语句。
 * 校验顺序即报错优先级：载荷坏（非数组/空数组/缺 id·tier·why/id 非整数/why 空串）
 * → bad_payload；档位越界 → bad_tier；条目查无 → no_item。逐条按序验，先炸先报。
 * 已判条目允许覆盖（改判是正常操作，改判理由由调用方写进 why）。
 * 成功后同一 SAVEPOINT 里落一条 digest：这批候选来自最近摄取轮（lastRun 只认 id
 * 最大的那条，不挑状态），headline 与 tiers 同源计数，杜绝摘要和卡片各说各话。
 * digests.run_id 是 NOT NULL（计划已取舍：不放宽、零迁移），库里一轮都没有时
 * digest 写不进去，整批响亮回滚——候选本来就来自摄取轮，正常流程到不了那状态。
 */
export function saveVerdicts(db, verdicts, now = Date.now) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) throw new Error('bad_payload')
  const exists = db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1')
  for (const v of verdicts) {
    if (v == null || typeof v !== 'object'
      || !Number.isInteger(v.id) || v.tier === undefined
      || typeof v.why !== 'string' || v.why.length === 0) throw new Error('bad_payload')
    if (!VERDICT_TIERS.includes(v.tier)) throw new Error('bad_tier')
    if (!exists.get(v.id)) throw new Error('no_item')
  }
  const tiers = { '值得看': 0, '可以看': 0, '不值当': 0 }
  for (const v of verdicts) tiers[v.tier]++
  const judged = verdicts.length
  // now 只取一次：digest 的 created_at 和 stats_json.at 必须是同一个值
  const at = now()
  db.exec('SAVEPOINT save_verdicts')
  try {
    const set = db.prepare("UPDATE items SET status='judged', verdict_tier=?, verdict_why=? WHERE id=?")
    for (const v of verdicts) set.run(v.tier, v.why, v.id)
    const headline = `判了 ${judged} 条：值得看 ${tiers['值得看']} · 可以看 ${tiers['可以看']} · 不值当 ${tiers['不值当']}`
    db.prepare('INSERT INTO digests (run_id, created_at, headline, stats_json, markdown_path, theme_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(lastRun(db)?.id ?? null, at, headline, JSON.stringify({ judged, tiers, at }), null, null)
    db.exec('RELEASE save_verdicts')
  } catch (e) {
    try {
      db.exec('ROLLBACK TO save_verdicts')
      db.exec('RELEASE save_verdicts')
    } catch {}
    throw e
  }
  return { judged, tiers }
}

/** 汇报区取最近几条 digest；倒序按 id（自增，等价于时间先后且不受同秒干扰）。 */
export function latestDigests(db, limit) {
  return db.prepare('SELECT id, headline, created_at, stats_json FROM digests ORDER BY id DESC LIMIT ?').all(limit)
}

/* ---------------- 收藏夹 ---------------- */

/** 名称规则的单一真相源：路由与 store 都靠它，别在路由里再抄一遍校验。 */
export function checkFolderName(raw) {
  if (typeof raw !== 'string') throw new Error('bad_name')
  const name = raw.trim()
  if (!name) throw new Error('bad_name')
  // 用码点而不是 .length，否则 emoji 名会被算成两个字符而误拒
  if ([...name].length > 40) throw new Error('name_too_long')
  return name
}

function folderRow(db, id) {
  const r = db.prepare('SELECT id, name, created_at, is_default FROM folders WHERE id = ?').get(id)
  if (!r) throw new Error('no_folder')
  return r
}

export function createFolder(db, raw, now = Date.now) {
  const name = checkFolderName(raw)
  // now 只取一次：入库的时间戳和返回给调用方的必须是同一个值
  const ts = now()
  try {
    const r = db.prepare('INSERT INTO folders (name, created_at, is_default) VALUES (?, ?, 0)')
      .run(name, ts)
    return { id: Number(r.lastInsertRowid), name, created_at: ts, is_default: 0 }
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new Error('name_taken')
    throw e
  }
}

export function renameFolder(db, id, raw) {
  const cur = folderRow(db, id)
  const name = checkFolderName(raw)
  try {
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, cur.id)
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new Error('name_taken')
    throw e
  }
  return { id: cur.id, name }
}

export function deleteFolder(db, id) {
  const cur = folderRow(db, id)
  // 默认夹不可删是两层拒绝里的一层（另一层在 index.js 的路由）。删它只会让"随手一收"没落点。
  if (cur.is_default) throw new Error('default_folder')
  db.prepare('DELETE FROM folders WHERE id = ?').run(cur.id)
  return { deleted: true, folder_id: cur.id }
}

export function listFolders(db) {
  return db.prepare(`
    SELECT f.id, f.name, f.is_default,
           (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = f.id) AS count
    FROM folders f
    ORDER BY f.is_default DESC, f.created_at ASC, f.id ASC
  `).all().map((r) => ({ ...r, is_default: r.is_default ? 1 : 0 }))
}

/**
 * 全量替换一条条目的夹成员（实现是差量应用：已有的配对保留原 added_at，
 * 新增的才拿 now()——见下方注释）。一个事务：中途报错就整个回滚，
 * 否则会出现"移出了旧夹但没进新夹"，用户看到的条目凭空少了一个归属。
 * 校验全在写之前，所以最常见的失败（未知夹、条目不存在）根本不会碰到关系表。
 * 入参从严：folderIds 缺席或不是数组一律 bad_payload——把它当成 [] 等于
 * 一次调用手滑就把这条的全部归属清空，这种破坏性默认必须是响亮失败。
 * 数组里混进非整数元素同理：报 no_folder，不静默丢掉那部分意图。
 */
export function setItemFolders(db, itemId, folderIds, now = Date.now) {
  const id = Number(itemId)
  if (!Number.isInteger(id)) throw new Error('no_item')
  if (!db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1').get(id)) throw new Error('no_item')
  if (!Array.isArray(folderIds)) throw new Error('bad_payload')
  const wanted = [...new Set(folderIds.map((x) => Number(x)))]
  for (const fid of wanted) {
    if (!Number.isInteger(fid) || !db.prepare('SELECT 1 FROM folders WHERE id = ? LIMIT 1').get(fid)) {
      throw new Error('no_folder')
    }
  }
  const at = now()
  // node:sqlite 没有 better-sqlite3 那个 db.transaction()（本机 24.15 实测：
  // DatabaseSync 只有 open/close/prepare/exec/function/aggregate…）。
  // 用 SAVEPOINT 而不是 BEGIN：单独调用时它等价于 BEGIN/COMMIT，
  // 被包在别的事务里时只回滚自己这一段，不会让外层炸 "no transaction is active"。
  db.exec('SAVEPOINT set_item_folders')
  try {
    // 差量应用而不是"全删重插"：已存在的配对保留它自己的 added_at——那是用户第一次决定
    // 把这条收进这个夹的时间（spec §6.2：卡上显示"我什么时候决定留下的"）。
    // 全删重插会让"再加第二个夹"把第一个夹的时间统一改写成 now()。
    // 移出再收回来走的是 INSERT 分支，天然拿到新时间——那确实是一次新决定。
    const present = new Set(db.prepare('SELECT folder_id FROM folder_items WHERE item_id = ?').all(id).map((r) => r.folder_id))
    const wantedSet = new Set(wanted)
    const del = db.prepare('DELETE FROM folder_items WHERE item_id = ? AND folder_id = ?')
    for (const fid of present) if (!wantedSet.has(fid)) del.run(id, fid)
    const ins = db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, ?)')
    for (const fid of wanted) if (!present.has(fid)) ins.run(fid, id, at)
    db.exec('RELEASE set_item_folders')
  } catch (e) {
    try {
      db.exec('ROLLBACK TO set_item_folders')
      db.exec('RELEASE set_item_folders')
    } catch {}
    throw e
  }
  return { item_id: id, folder_ids: wanted }
}

export function foldersOfItem(db, itemId) {
  return db.prepare(`
    SELECT fi.folder_id FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    WHERE fi.item_id = ?
    ORDER BY f.is_default DESC, f.created_at ASC, f.id ASC
  `).all(Number(itemId)).map((r) => r.folder_id)
}

/** runner 的归档豁免用这一条。EXISTS 而不是 COUNT(*)，取一个布尔就别数全表。 */
export function isCollected(db, itemId) {
  return Boolean(db.prepare('SELECT 1 FROM folder_items WHERE item_id = ? LIMIT 1').get(Number(itemId)))
}

/**
 * 收藏页的取数：条目 + 它所属的夹 id + 夹名。
 * 面板要在一趟请求里拿到"这条还在哪些夹里"，否则卡片上那一行只能留空——
 * 而多夹归属不写出来，用户移出时根本不知道自己顺手动了哪个夹。
 */
export function itemsWithFolders(db, opts = {}) {
  const rows = listItems(db, opts)
  if (!rows.length) return []
  // 夹名单一次取：在映射里逐条查的话，200 条就是 200 次查询。
  const names = new Map(listFolders(db).map((f) => [f.id, f.name]))
  const order = [...names.keys()]
  // added_at 长在关系表上、不在 items 里（ITEM_COLS 没这列）：收藏时间必须在这里投影出去，
  // 否则 views/collections.js 读 item.added_at 永远是 undefined，每张卡都写"（时间未知）"。
  const pairs = db.prepare('SELECT item_id, folder_id, added_at FROM folder_items').all()
  const byItem = new Map()
  for (const p of pairs) {
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, [])
    byItem.get(p.item_id).push(p)
  }
  // folder 的解析与 listItems 同款（脏值当没带）。语义分两种：
  //  ① 带 folder 筛 → 取"进这个夹"那条关系的 added_at——这页回答的是"它什么时候到我这个夹里的"；
  //  ② 不带筛 → 一条可以进过好几个夹，"收进来"没有单一答案，取 MIN（最早那次归属）：
  //     那才是"第一次决定留下"的时刻；取 MAX 会把"最后一次加夹"说成整条的收藏时间。
  const folder = opts.folder != null && Number.isInteger(Number(opts.folder)) ? Number(opts.folder) : null
  return rows.map((r) => {
    const ps = byItem.get(r.id) ?? []
    // 顺序跟 listFolders 走（默认夹最前、其后按创建时间），不是按加入时间
    const ids = ps.map((p) => p.folder_id).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const addedAt = folder == null
      ? (ps.length ? Math.min(...ps.map((p) => p.added_at)) : null)
      : ps.find((p) => p.folder_id === folder)?.added_at ?? null
    return { ...r, folders: ids, folder_names: ids.map((id) => names.get(id)), added_at: addedAt }
  })
}
