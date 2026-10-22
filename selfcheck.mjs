// selfcheck.mjs —— V1：node:sqlite 能否建表、插入、查询、处理中文
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
const ins = db.prepare('INSERT INTO t (name) VALUES (?)')
ins.run('值得看')
ins.run('标题党「十款工具」')
const rows = db.prepare('SELECT id, name FROM t ORDER BY id').all()
const ok = rows.length === 2 && rows[0].name === '值得看' && rows[1].name.includes('十款工具')
process.stdout.write(`node:sqlite ${ok ? 'OK' : 'FAIL'} ${JSON.stringify(rows)}\n`)
process.exitCode = ok ? 0 : 1
