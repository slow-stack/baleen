import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { openStore, migrate, listSources, getCursor, candidates, counts } from '../lib/store.js'
import { runOnce, syncSources, planJobs } from '../lib/runner.js'
import { fakeAdapter, rawOf, timeoutError } from './helpers/fake-adapter.js'

const pref = {
  themes: [{ group: 'AI', must: [], any: ['DSH', 'MCP'], never: ['盘点'], weight: 1 }],
  follow: { feeds: [] },
  redlines: ['引流'],
  tuning: { source_delta: {} },
  schedule: { windows: ['00:00-23:59'], max_per_run: 5, max_per_day: 40 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  sources: [
    { id: 'ok', type: 'rss', url: 'https://e.com/feed', enabled: true, interval_min: 60, weight: 1 },
    { id: 'bad', type: 'rss', url: 'https://e.com/bad', enabled: true, interval_min: 60, weight: 1 },
    { id: 'off', type: 'rss', url: 'https://e.com/off', enabled: false, interval_min: 60, weight: 1 }
  ]
}
const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }

const goodItems = () => [
  rawOf('ok', { external_id: 'a' }),
  rawOf('ok', { external_id: 'b', title: 'MCP 的三种接法' }),
  rawOf('ok', { external_id: 'c', title: '盘点来了' })
]
const adapters = () => ({ rss: fakeAdapter('rss', { ok: { items: goodItems() }, bad: { error: timeoutError() } }) })
const sinceFor = (adv, id) => (adv.seen.find(s => s.id === id) ?? {}).since

test('syncSources 镜像偏好但不删运行态，enabled 落库', () => {
  const db = dbOf()
  syncSources(db, pref)
  const rows = listSources(db)
  assert.deepEqual(rows.map(r => r.id).sort(), ['bad', 'off', 'ok'])
  assert.equal(rows.find(r => r.id === 'off').enabled, 0)
})

test('planJobs 只给启用的源，带上该源游标和本轮窗口终点', () => {
  const db = dbOf()
  syncSources(db, pref)
  const jobs = planJobs({ db, pref, now: () => 5000 })
  assert.deepEqual(jobs.map(j => j.source.id).sort(), ['bad', 'ok'])
  assert.equal(jobs[0].since, null)
  assert.equal(jobs[0].windowEnd, 5000)
})

test('一轮：好源入库、坏源不推进游标、never 条目被预筛丢弃', async () => {
  const db = dbOf()
  const { runId, status, stats } = await runOnce({ db, pref, now: () => 5000, adapters: adapters(), trigger: 'manual' })
  assert.equal(status, 'partial')
  assert.equal(stats.fetched, 3)
  assert.equal(stats.inserted, 3)
  assert.equal(stats.archived, 1)
  assert.equal(stats.candidates, 2)
  assert.equal(getCursor(db, 'ok'), new Date(5000).toISOString())
  assert.equal(getCursor(db, 'bad'), null)
  const per = JSON.parse(db.prepare('SELECT per_source_json FROM runs WHERE id=?').get(runId).per_source_json)
  assert.deepEqual(per.bad, { ok: false, fetched: 0, error_class: 'timeout' })
  assert.equal(per.ok.ok, true)
  const archived = db.prepare("SELECT archived_reason FROM items WHERE status='archived'").get()
  assert.match(archived.archived_reason, /^theme-reject:never/)
})

test('下一轮把上轮游标当 since；旧条目回来也只 update 不重复入库', async () => {
  const db = dbOf()
  const A = adapters()
  await runOnce({ db, pref, now: () => 5000, adapters: A })
  // 假适配器不做 since 过滤（那是 rss 适配器的职责，另有测试盯它），
  // 所以这里正好验证第二道防线：回来的旧条目不会变成第二行、也不会重新排队判断。
  const B = fakeAdapter('rss', { ok: { items: [rawOf('ok', { external_id: 'a', published_at: 4000 })] }, bad: { items: [] } })
  const r2 = await runOnce({ db, pref, now: () => 9000, adapters: { rss: B }, trigger: 'schedule' })
  assert.equal(sinceFor(B, 'ok'), 5000)
  assert.equal(sinceFor(B, 'bad'), null)
  assert.equal(r2.stats.inserted, 0)
  assert.equal(r2.stats.updated, 1)
  assert.equal(r2.status, 'done')
  assert.deepEqual(counts(db), { new: 2, judged: 0, digest: 0, archived: 1, total: 3 })
})

test('坏源恢复后补齐缺口：因为游标一直是 null', async () => {
  const db = dbOf()
  await runOnce({ db, pref, now: () => 5000, adapters: adapters() })
  const fix = fakeAdapter('rss', { ok: { items: [] }, bad: { items: [rawOf('bad', { external_id: 'late', title: 'DSH 会话的注入点在哪' })] } })
  const r = await runOnce({ db, pref, now: () => 9000, adapters: { rss: fix } })
  assert.equal(sinceFor(fix, 'bad'), null)
  assert.equal(r.status, 'done')
  assert.ok(db.prepare("SELECT id FROM items WHERE external_id='late'").get())
  assert.equal(getCursor(db, 'bad'), new Date(9000).toISOString())
})

test('全部源失败 → failed；只留一个启用的成功源 → done', async () => {
  const db = dbOf()
  const all = fakeAdapter('rss', { ok: { error: timeoutError() }, bad: { error: timeoutError() } })
  const r = await runOnce({ db, pref, now: () => 5000, adapters: { rss: all } })
  assert.equal(r.status, 'failed')
  assert.equal(r.stats.candidates, 0)
  assert.equal(getCursor(db, 'ok'), null)
  const db2 = dbOf()
  const only = { rss: fakeAdapter('rss', { ok: { items: [] } }) }
  const r2 = await runOnce({ db: db2, pref: { ...pref, sources: [pref.sources[0]] }, now: () => 5000, adapters: only })
  assert.equal(r2.status, 'done')
})

test('已 judged 的条目不会重新进入候选队列', async () => {
  const db = dbOf()
  await runOnce({ db, pref, now: () => 5000, adapters: adapters() })
  const [first] = candidates(db, 10)
  db.prepare("UPDATE items SET status='judged' WHERE id=?").run(first.id)
  await runOnce({ db, pref, now: () => 9000, adapters: { rss: fakeAdapter('rss', { ok: { items: [rawOf('ok', { external_id: first.external_id, published_at: 8000 })] }, bad: { items: [] } }) } })
  assert.ok(!candidates(db, 50).some(r => r.id === first.id))
})

test('burned_in 条目保留但在 gaps 统计里看得见（不悄悄消失）', async () => {
  const db = dbOf()
  const items = [rawOf('ok', { external_id: 'bs', body_html: null, summary_html: null, hardsub_hint: true })]
  const one = { ...pref, sources: [pref.sources[0]] }
  const r = await runOnce({ db, pref: one, now: () => 5000, adapters: { rss: fakeAdapter('rss', { ok: { items } }) } })
  assert.equal(r.status, 'done')
  assert.equal(db.prepare("SELECT body_state FROM items").get().body_state, 'burned_in')
  assert.equal(r.stats.gaps.kept_with_flag.burned_in, 1)
})

test('日志不含家目录，失败源有记录', async () => {
  const db = dbOf()
  const lines = []
  await runOnce({ db, pref, now: () => 5000, adapters: adapters(), log: e => lines.push(JSON.stringify(e)) })
  const blob = lines.join('\n')
  assert.ok(!blob.includes(os.homedir()), '日志泄漏了家目录')
  assert.ok(!/[A-Za-z]:[\\/]{2}Users/i.test(blob), blob.slice(0, 200))
  assert.ok(lines.some(l => /"event":"source_failed"/.test(l)))
  assert.ok(lines.some(l => /"event":"run_end"/.test(l)))
})
