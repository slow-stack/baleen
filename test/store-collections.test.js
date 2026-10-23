import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, migrate, createFolder, renameFolder, deleteFolder, listFolders, setStatus
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

test('migrate 后恰好有一个默认夹，且重复 migrate 不会多出第二个', () => {
  const db = dbOf()
  assert.deepEqual(listFolders(db), [{ id: 1, name: '默认', is_default: 1, count: 0 }])
  migrate(db); migrate(db)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folders WHERE is_default = 1').get().n, 1)
  assert.equal(listFolders(db).length, 1)
  db.close()
})

test('老库补表：先建一张没有 folders 的库，migrate 之后默认夹自己长出来', () => {
  const { db } = openStore(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, external_id TEXT, kind TEXT, title TEXT, url TEXT, body_state TEXT, fetched_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT "new")')
  migrate(db)
  assert.equal(listFolders(db)[0].name, '默认')
  db.close()
})

test('建夹：名字进库、is_default 恒为 0、时间戳用传入的 now', () => {
  const db = dbOf()
  const f = createFolder(db, '公共管理', () => 2000)
  assert.equal(f.name, '公共管理')
  assert.equal(f.is_default, 0)
  assert.equal(f.created_at, 2000)
  assert.deepEqual(listFolders(db).map(x => x.name), ['默认', '公共管理'])
  db.close()
})

test('建夹的名字规则：空、纯空格、超长一律拒绝，且是拒绝而不是截断', () => {
  const db = dbOf()
  assert.throws(() => createFolder(db, ''), /bad_name/)
  assert.throws(() => createFolder(db, '   '), /bad_name/)
  assert.throws(() => createFolder(db, null), /bad_name/)
  assert.throws(() => createFolder(db, 'x'.repeat(41)), /name_too_long/)
  const ok = createFolder(db, '  ' + 'y'.repeat(40) + '  ')
  assert.equal(ok.name.length, 40, '首尾空白该去掉，中间保留')
  db.close()
})

test('重名拒绝，报错是 name_taken 而不是 SQLite 的 UNIQUE 约束原文', () => {
  const db = dbOf()
  createFolder(db, '考研')
  assert.throws(() => createFolder(db, '考研'), /name_taken/)
  assert.throws(() => createFolder(db, ' 考研 '), /name_taken/, '去空白后算同一个名字')
  assert.equal(listFolders(db).length, 2, '被拒的建夹不该留下半行')
  db.close()
})

test('改名：普通夹和默认夹都能改，改完 is_default 不变', () => {
  const db = dbOf()
  const f = createFolder(db, '旧名')
  renameFolder(db, f.id, '新名')
  assert.equal(listFolders(db).find(x => x.id === f.id).name, '新名')
  const d = renameFolder(db, 1, '我的收藏')
  assert.equal(d.name, '我的收藏')
  assert.equal(listFolders(db)[0].is_default, 1, '默认夹改名后仍排最前且还是默认')
  assert.throws(() => renameFolder(db, f.id, ''), /bad_name/)
  assert.throws(() => renameFolder(db, f.id, '我的收藏'), /name_taken/)
  assert.throws(() => renameFolder(db, 999, 'x'), /no_folder/)
  db.close()
})

test('删夹：只删收藏关系，条目一条都不动', () => {
  const db = dbOf()
  const f = createFolder(db, '要精读')
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 5)').run(f.id, a)
  deleteFolder(db, f.id)
  assert.equal(listFolders(db).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '级联没生效')
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(a), '条目被误删了')
  db.close()
})

test('默认夹删不掉，store 层就拒绝（不只靠 UI 不显示按钮）', () => {
  const db = dbOf()
  assert.throws(() => deleteFolder(db, 1), /default_folder/)
  assert.throws(() => deleteFolder(db, 999), /no_folder/)
  assert.equal(listFolders(db).length, 1)
  db.close()
})

test('count 含已归档条目：夹上写的数字必须等于点进去看到的条数', () => {
  const db = dbOf()
  const f = createFolder(db, '留档')
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const b = insRow(db, { external_id: 'b' }).lastInsertRowid
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 5)').run(f.id, a)
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 6)').run(f.id, b)
  setStatus(db, b, 'archived', 'stale:20 天前')
  assert.equal(listFolders(db).find(x => x.id === f.id).count, 2)
  db.close()
})

test('排序不依赖时钟：created_at 相同的两个夹按 id 排，默认夹永远在最前', () => {
  const db = dbOf()
  const fixed = () => 5000
  const x = createFolder(db, 'X', fixed)
  const y = createFolder(db, 'Y', fixed)
  assert.deepEqual(listFolders(db).map(f2 => f2.id), [1, x.id, y.id])
  db.prepare('UPDATE folders SET created_at = 1 WHERE id = ?').run(y.id)
  assert.deepEqual(listFolders(db).map(f2 => f2.id), [1, y.id, x.id])
  db.close()
})
