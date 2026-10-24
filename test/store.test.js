import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore, migrate, setMeta, getMeta } from '../lib/store.js'

// 测试自清（终审 #21）：落盘的库只在"建在给定目录"那条用到真目录，登记后收尾钩子统一删
// （那条测试自己 close 了库句柄——Windows 上不先关，rmSync 会 EPERM）。
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

test('migrate 建出五张表且可重复执行', () => {
  const { db } = openStore(':memory:')
  migrate(db); migrate(db)
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)
  for (const t of ['items', 'runs', 'digests', 'sources', 'meta']) {
    assert.ok(names.includes(t), `缺表 ${t}`)
  }
  db.close()
})

test('items 的 (source_id, external_id) 唯一', () => {
  const { db } = openStore(':memory:')
  migrate(db)
  const sql = `INSERT INTO items (source_id, external_id, kind, title, url, body_state, status, fetched_at)
               VALUES ('s1','e1','article','t','u','full','new',1)`
  db.prepare(sql).run()
  assert.throws(() => db.prepare(sql).run(), /UNIQUE/)
  db.close()
})

test('meta 读写与覆盖', () => {
  const { db } = openStore(':memory:')
  migrate(db)
  assert.equal(getMeta(db, 'nope'), null)
  setMeta(db, 'cursor:s1', '2026-10-23T00:00:00.000Z')
  assert.equal(getMeta(db, 'cursor:s1'), '2026-10-23T00:00:00.000Z')
  setMeta(db, 'cursor:s1', '2026-10-24T00:00:00.000Z')
  assert.equal(getMeta(db, 'cursor:s1'), '2026-10-24T00:00:00.000Z')
  db.close()
})

test('必填列缺值时直接抛，不写半成品', () => {
  const { db } = openStore(':memory:')
  migrate(db)
  assert.throws(() => db.prepare(
    "INSERT INTO items (source_id, external_id, kind, title, url, status, fetched_at) VALUES ('a','b','video','t','u','new',1)"
  ).run(), /NOT NULL/)
  db.close()
})

test('openStore 把库文件建在给定目录下（含不存在的父目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-store-'))
  tmpDirs.push(dir)
  const { db, file } = openStore(path.join(dir, 'nested', 'baleen.sqlite'))
  migrate(db)
  db.prepare("INSERT INTO items (source_id, external_id, kind, title, url, body_state, status, fetched_at) VALUES ('s','e','article','t','u','full','new',1)").run()
  db.close()
  assert.ok(fs.existsSync(file), '库文件没生成')
})
