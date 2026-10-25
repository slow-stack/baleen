import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { openStore, migrate, listSources, getCursor, candidates, counts, createFolder, setItemFolders } from '../lib/store.js'
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

test('一个源都没启用时记 done，不是 failed（别让小面板亮假红点）', async () => {
  const db = dbOf()
  const none = { ...pref, sources: pref.sources.map(s => ({ ...s, enabled: false })) }
  const r = await runOnce({ db, pref: none, now: () => 5000, adapters: { rss: fakeAdapter('rss', {}) } })
  assert.equal(r.status, 'done')
  assert.equal(r.stats.fetched, 0)
  assert.equal(r.stats.candidates, 0)
  assert.deepEqual(r.stats.per_source, {})
  assert.equal(lastRunOf(db).error, null)
})

const lastRunOf = (db) => db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()

test('首轮 backlog 不看过期；之后按该源的过期窗过滤', async () => {
  const DAY = 86400000
  const p = { ...pref, sources: [{ id: 'slow', type: 'rss', url: 'https://e.com/slow', enabled: true, interval_min: 60, weight: 1, max_age_days: 365 }] }
  const db = dbOf()
  const A = fakeAdapter('rss', { slow: { items: [rawOf('slow', { external_id: 'x1', title: 'DSH 的旧文', published_at: 5000 - 100 * DAY })] } })
  const r1 = await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: A } })
  assert.equal(r1.stats.candidates, 1)          // 没有游标 = 首轮 = 存货对你就是新的
  assert.equal(r1.stats.archived, 0)

  const B = fakeAdapter('rss', { slow: { items: [rawOf('slow', { external_id: 'x2', title: 'DSH 太老的文', published_at: 5000 - 400 * DAY })] } })
  const r2 = await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: B } })
  assert.equal(r2.stats.candidates, 0)          // 第二轮起才用 365 天窗
  assert.match(db.prepare("SELECT archived_reason FROM items WHERE external_id='x2'").get().archived_reason, /^stale:400 天前/)

  const C = fakeAdapter('rss', { slow: { items: [rawOf('slow', { external_id: 'x3', title: 'DSH 中年的文', published_at: 5000 - 200 * DAY })] } })
  const r3 = await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: C } })
  assert.equal(r3.stats.candidates, 1)          // 200 天在该源的窗内，全局 14 天被覆盖掉了
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

const DAY = 86400000
const staleSource = () => ({ ...pref, sources: [{ id: 'slow', type: 'rss', url: 'https://e.com/slow', enabled: true, interval_min: 60, weight: 1 }] })
const twoStale = () => [
  rawOf('slow', { external_id: 'keep', title: 'DSH 的存货', published_at: 5000 - 100 * DAY }),
  rawOf('slow', { external_id: 'drop', title: 'DSH 的另一份存货', published_at: 5000 - 100 * DAY })
]
const statusOf = (db, eid) => db.prepare('SELECT status, archived_reason FROM items WHERE external_id = ?').get(eid)

test('收过的条目第二轮过期不归档；没收过的照旧归档（豁免不是关掉清理）', async () => {
  const db = dbOf()
  const p = staleSource()
  const A = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: A } })   // 首轮 backlog：两条都入库且不看过期
  const keepId = db.prepare("SELECT id FROM items WHERE external_id='keep'").get().id
  setItemFolders(db, keepId, [createFolder(db, '留档').id])

  const B = fakeAdapter('rss', { slow: { items: twoStale() } })
  const r = await runOnce({ db, pref: p, now: () => 5000 + 15 * DAY, adapters: { rss: B } })

  assert.equal(statusOf(db, 'keep').status, 'new', '收过的被误归档了')
  assert.equal(statusOf(db, 'drop').status, 'archived', '没收的那条该照旧归档')
  assert.match(statusOf(db, 'drop').archived_reason, /^stale:/)
  assert.equal(r.stats.archived, 1, '归档计数把被豁免的那条也算进去了')
  // 豁免只是"不改归档"，不是"重新送回候选"：这一轮两条都没过闸，候选必须还是 0。
  assert.equal(r.stats.candidates, 0, '被豁免的条目不算候选')
  // 豁免不是静默："丢弃没发生"这件事要进汇报的第三个桶（用户 2026-10-25 批准），
  // 否则面板永远看不见"今天有 N 条因收藏未清理"。
  assert.equal(r.stats.gaps.held, 1, '被豁免的那条必须进收藏钉住计数')
})

test('移出夹之后，下一轮的过期清理照旧生效（钉住不等于永久免死）', async () => {
  const db = dbOf()
  const p = staleSource()
  const A = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: A } })
  const keepId = db.prepare("SELECT id FROM items WHERE external_id='keep'").get().id
  const f = createFolder(db, '留档').id
  setItemFolders(db, keepId, [f])
  const B = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000 + 15 * DAY, adapters: { rss: B } })
  assert.equal(statusOf(db, 'keep').status, 'new')

  setItemFolders(db, keepId, [])
  const C = fakeAdapter('rss', { slow: { items: twoStale() } })
  const r3 = await runOnce({ db, pref: p, now: () => 5000 + 16 * DAY, adapters: { rss: C } })
  assert.equal(statusOf(db, 'keep').status, 'archived', '移出后还免归档，说明豁免读的不是当前状态')
  // 移出夹之后豁免不再生效：钉住计数归零，归档只这一条（drop 上一轮已归档，这轮 skip_seen 不重复计）。
  assert.equal(r3.stats.gaps.held, 0, '移出夹之后钉住计数必须归零')
  assert.equal(r3.stats.archived, 1, '最后一轮的归档只有移出夹的那条')
})

test('fetch 选项带 pref（inject_prompt 等顶层偏好要能到适配器）', async () => {
  const db = dbOf()
  const seen = []
  await runOnce({ db, pref, now: () => 5000, adapters: { rss: { type: 'rss', async fetch(source, opts) { seen.push(opts); return [] } } } })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].pref, pref)
  assert.equal(seen[0].since, null)
})
