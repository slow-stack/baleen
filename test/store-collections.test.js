import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, migrate, createFolder, renameFolder, deleteFolder, listFolders, setStatus,
  setItemFolders, foldersOfItem, isCollected, listItems
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

test('setItemFolders 是全量替换，重复提交同一集合不产生新行', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f1 = createFolder(db, '一').id
  const f2 = createFolder(db, '二').id
  setItemFolders(db, a, [f1, f2], () => 7000)
  setItemFolders(db, a, [f1, f2], () => 8000)
  assert.deepEqual(foldersOfItem(db, a).sort((x, y) => x - y), [f1, f2])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 2, '重复提交写出了多余的行')
  db.close()
})

test('提交空集合就是"全部移出"，不是把行删掉', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  setItemFolders(db, a, [])
  assert.deepEqual(foldersOfItem(db, a), [])
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(a))
  db.close()
})

test('foldersOfItem 的顺序跟 listFolders 一致，收藏页两侧不会看到两种顺序', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const y = createFolder(db, 'Y', () => 300).id
  const z = createFolder(db, 'Z', () => 100).id
  setItemFolders(db, a, [y, z])
  assert.deepEqual(foldersOfItem(db, a), listFolders(db).filter((f) => f.id !== 1).map((f) => f.id))
  assert.deepEqual(foldersOfItem(db, a), [z, y], 'created_at 升序：Z 更早建')
  db.close()
})

test('未知夹与不存在条目分别报错，不静默写出悬空关系', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  assert.throws(() => setItemFolders(db, a, [f, 999]), /no_folder/)
  assert.deepEqual(foldersOfItem(db, a), [], '中途失败不该留下半套关系')
  assert.throws(() => setItemFolders(db, 9999, [f]), /no_item/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
  db.close()
})

test('isCollected：收过为真，移出后为假', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  assert.equal(isCollected(db, a), false)
  setItemFolders(db, a, [f])
  assert.equal(isCollected(db, a), true)
  setItemFolders(db, a, [])
  assert.equal(isCollected(db, a), false)
  db.close()
})

test('listItems 的 folder 按夹取，且归档的照样取得到', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const b = insRow(db, { external_id: 'b' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  setItemFolders(db, b, [f])
  setStatus(db, b, 'archived', 'stale:20 天前')
  assert.deepEqual(listItems(db, { folder: f }).map((r) => r.external_id).sort(), ['a', 'b'])
  assert.deepEqual(listItems(db, { folder: f, status: 'new' }).map((r) => r.external_id), ['a'])
  assert.deepEqual(listItems(db, { folder: 999 }), [])
  assert.equal(listItems(db, { folder: null }).length, 2, '不传 folder 时行为与从前完全一致')
  db.close()
})

test('删条目时收藏关系自己消失（FK 级联），不会留下悬空指针', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  db.prepare('DELETE FROM items WHERE id = ?').run(a)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
  assert.equal(listFolders(db).find((x) => x.id === f).count, 0)
  db.close()
})

// 下面四条补的是 brief 自己覆盖不到的四处：Task 1 评审留下的三个缺口
// （级联"只删本夹"的性质、码点计数的那句注释、migrate 的 INSERT OR IGNORE），
// 加上事务注释承诺的回滚——brief 的七条里没有一条能让它变红。

test('同一个条目挂在两个夹上：删掉其中一个，另一个的关系和条目都还活着', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const b = insRow(db, { external_id: 'b' }).lastInsertRowid
  const doomed = createFolder(db, '要删的')
  const kept = createFolder(db, '留下的')
  setItemFolders(db, a, [doomed.id, kept.id])
  setItemFolders(db, b, [doomed.id])
  deleteFolder(db, doomed.id)
  // 只该删掉 doomed 那两条关系：整张 folder_items 清空也算"过"的那种假绿要钉住
  assert.deepEqual(foldersOfItem(db, a), [kept.id], '另一个夹的关系被误删了')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 1, '级联删超了')
  assert.equal(listFolders(db).find((x) => x.id === kept.id).count, 1)
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(a), '条目被连带删了')
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(b), '只挂被删夹的条目也被连带删了')
  assert.deepEqual(listItems(db, { folder: kept.id }).map((x) => x.external_id), ['a'])
  db.close()
})

test('名字长度按码点算：40 个 emoji 收、41 个拒（按 .length 会把这条误拒）', () => {
  const db = dbOf()
  const ok = createFolder(db, '🐟'.repeat(40))
  assert.equal(ok.name, '🐟'.repeat(40))
  assert.equal([...ok.name].length, 40, '码点数正好 40，该收')
  assert.equal(ok.name.length, 80, '这条测试的前提：UTF-16 单元数是 80，两种数法在这里分家')
  assert.throws(() => createFolder(db, '🐟'.repeat(41)), /name_too_long/)
  assert.equal(listFolders(db).length, 2, '被拒的名字不该留下半行')
  db.close()
})

test('库外手术造出的"零默认夹 + 已有一个叫默认的夹"：migrate 不炸，也不写出第二行', () => {
  const db = dbOf()
  // 插件自己的路径到不了这个状态（默认夹删不掉、同名建不了），只能库外改，
  // 但 spec §3 要求 migrate 在这种库上"重复执行不炸"——裸 INSERT 会撞 folders.name 的 UNIQUE。
  db.prepare('DELETE FROM folders WHERE is_default = 1').run()
  db.prepare('INSERT INTO folders (name, created_at, is_default) VALUES (?, ?, 0)').run('默认', 1)
  assert.equal(listFolders(db).length, 1)
  migrate(db)
  assert.doesNotThrow(() => migrate(db))
  assert.equal(listFolders(db).length, 1, 'OR IGNORE 跳过就是一条都不多写')
  db.close()
})

test('写关系写到一半失败：旧关系原样退回，不会只剩"移出了旧夹"', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f1 = createFolder(db, '一').id
  const f2 = createFolder(db, '二').id
  setItemFolders(db, a, [f1], () => 7000)
  // 故障注入：added_at 拿到一个 node:sqlite 拒绝绑定的值，INSERT 必在 DELETE 之后炸。
  // 这里验的不是"now 可以乱传"，是那句事务注释承诺的回滚性质。
  assert.throws(() => setItemFolders(db, a, [f1, f2], () => ({})), /cannot be bound/)
  assert.deepEqual(foldersOfItem(db, a), [f1], '回滚没生效：旧夹的归属被 DELETE 走了')
  assert.equal(isCollected(db, a), true, '半途失败把条目变成了"没被收藏过"')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 1)
  // 失败不能把连接带坏：紧接着的正常提交照样管用
  assert.deepEqual(setItemFolders(db, a, [f2], () => 9000).folder_ids, [f2])
  assert.deepEqual(foldersOfItem(db, a), [f2])
  db.close()
})
