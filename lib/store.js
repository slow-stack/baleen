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
