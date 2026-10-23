import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { redact, makeLogger } from '../lib/diag.js'

test('脱敏掉家目录、Windows 盘符路径与凭据值', () => {
  const home = os.homedir()
  assert.match(redact(`读不到 ${home}/.dsh/baleen/x`), /<HOME>/, '家目录未脱敏')
  assert.match(redact('打不开 D:\\SomeUser\\secrets'), /<PATH>/)
  const r = redact('authorization: Bearer abc.def; Cookie: sid=1')
  assert.ok(!r.includes('abc.def'), r)
  assert.ok(!r.includes('sid=1'), r)
  assert.match(r, /<REDACTED>/)
})

test('脱敏不吃掉正常内容：中文、URL、错误类名都要留着', () => {
  const s = 'source_failed：timeout https://e.com/feed 抓到 0 条'
  assert.equal(redact(s), s)
})

test('日志每行是合法 JSON、不超 400 字符、失败不抛', () => {
  const chunks = []
  const log = makeLogger({ file: 'x.jsonl', now: () => 1000, append: (f, s) => chunks.push(s) })
  log({ level: 'info', event: 'run_start', detail: 'y'.repeat(2000) })
  const line = chunks[0].trim()
  assert.ok(line.length <= 400, `行长 ${line.length}`)
  const e = JSON.parse(line)
  assert.equal(e.event, 'run_start')
  assert.equal(e.at, 1000)
})

test('写盘失败绝不影响调用方（日志坏了不能把抓取拖死）', () => {
  const log = makeLogger({ file: 'x.jsonl', now: () => 1, append: () => { throw new Error('磁盘满了') } })
  assert.doesNotThrow(() => log({ event: 'run_end', detail: 'ok' }))
})

test('logger 缺 file 时只走注入的 sink，不落盘', () => {
  const got = []
  const log = makeLogger({ now: () => 5, sink: e => got.push(e) })
  log({ event: 'tick', detail: '窗外' })
  assert.equal(got.length, 1)
  assert.equal(got[0].at, 5)
})
