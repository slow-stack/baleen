import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore, migrate, createRun, finishRun, upsertSource, setSourceResult } from '../lib/store.js'
import { withinWindow, dueReason, createScheduler } from '../lib/scheduler.js'

// 用本地时区构造时刻，避免测试依赖机器是不是 +08
const at = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return new Date(2026, 9, 23, h, m, 0).getTime()
}
const pref = { schedule: { windows: ['07:00-09:00', '12:30-13:30'], max_per_run: 10 } }
const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
// 测试自清（终审 #21）：锁文件跟着目录一起删；库全是 :memory: 且各测试自己 close，无句柄残留。
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })
const dirOf = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-sched-'))
  tmpDirs.push(d)
  return d
}

test('时段窗：窗内真、窗外假、含起点不含终点、空窗不限', () => {
  assert.equal(withinWindow(['07:00-09:00'], at('07:00')), true)
  assert.equal(withinWindow(['07:00-09:00'], at('08:59')), true)
  assert.equal(withinWindow(['07:00-09:00'], at('09:00')), false)
  assert.equal(withinWindow(['07:00-09:00', '12:30-13:30'], at('12:45')), true)
  assert.equal(withinWindow([], at('03:00')), true)
  assert.equal(withinWindow(undefined, at('03:00')), true)
})

test('跨零点的窗（18:00-09:00）早晚都算，下午三点不算', () => {
  assert.equal(withinWindow(['18:00-09:00'], at('21:00')), true)
  assert.equal(withinWindow(['18:00-09:00'], at('03:00')), true)
  assert.equal(withinWindow(['18:00-09:00'], at('08:59')), true)
  assert.equal(withinWindow(['18:00-09:00'], at('15:00')), false)
})

test('写错的窗直接被忽略而不是抛', () => {
  assert.equal(withinWindow(['7am-9am'], at('08:00')), false)
  assert.equal(withinWindow(['07:00-09:00', '坏掉的'], at('08:00')), true)
})

test('不在窗内报 window；正在跑报 running；离上次太近报 too-soon', () => {
  const db = dbOf()
  assert.equal(dueReason({ db, pref, now: () => at('20:00'), running: false }), 'window')
  assert.equal(dueReason({ db, pref, now: () => at('08:00'), running: true }), 'running')
  const id = createRun(db, 'schedule', () => at('08:00'))
  finishRun(db, id, { status: 'done' }, () => at('08:01'))
  assert.equal(dueReason({ db, pref, now: () => at('08:05'), running: false, minGapMs: 600000 }), 'too-soon')
  assert.equal(dueReason({ db, pref, now: () => at('08:20'), running: false, minGapMs: 600000 }), null)
  db.close()
})

test('off_peak_only 关掉后时段窗不再拦：设置页那个复选框不是装饰', () => {
  const db = dbOf()
  // 窗外（20:00）+ 默认（缺省即 true）→ 拦
  assert.equal(dueReason({ db, pref, now: () => at('20:00'), running: false }), 'window')
  // 显式关掉 → 窗外也放行
  const off = { schedule: { ...pref.schedule, off_peak_only: false } }
  assert.equal(dueReason({ db, pref: off, now: () => at('20:00'), running: false }), null)
  // 开着（true）与缺省行为一致，不许两种写法两种结果
  const on = { schedule: { ...pref.schedule, off_peak_only: true } }
  assert.equal(dueReason({ db, pref: on, now: () => at('20:00'), running: false }), 'window')
  db.close()
})

test('triggerNow 无视时段窗，但受单实例锁约束', async () => {
  let runs = 0
  const slow = async () => { runs++; await new Promise(r => setTimeout(r, 30)); return { runId: 1, status: 'done', stats: {} } }
  const db = dbOf()
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }), runOnce: slow,
    now: () => at('20:00'), log: () => {}, lockFile: path.join(dirOf(), 'run.lock')
  })
  const p = await Promise.all([s.triggerNow(), s.triggerNow()])
  assert.deepEqual(p.map(r => r.skipped), [false, true])
  assert.equal(p[1].why, 'running')
  assert.equal(runs, 1)
  db.close()
})

test('偏好校验不过时不起跑，并把 errors 交回去', async () => {
  const db = dbOf()
  let runs = 0
  const s = createScheduler({
    db, getPref: () => ({ pref: {}, errors: ['schedule.windows[0]: 要写成 "07:00-09:00"'] }),
    runOnce: async () => { runs++; return {} }, now: () => at('08:00'), log: () => {},
    lockFile: path.join(dirOf(), 'run.lock')
  })
  const r = await s.triggerNow()
  assert.equal(r.skipped, true)
  assert.equal(r.why, 'preference')
  assert.equal(runs, 0)
  db.close()
})

test('手动触发把 force 传下去：定时轮被节流挡住时，手动轮仍能真的跑', async () => {
  const db = dbOf()
  const seen = []
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }),
    runOnce: async (opts) => { seen.push({ trigger: opts.trigger, force: opts.force }); return { runId: 1, status: 'done', stats: {} } },
    now: () => at('08:00'), log: () => {}, lockFile: path.join(dirOf(), 'run.lock')
  })
  await s.triggerNow()
  await s.tick()
  assert.deepEqual(seen[0], { trigger: 'manual', force: true }, '手动轮要 force')
  assert.deepEqual(seen[1], { trigger: 'schedule', force: false }, '定时轮不许 force，否则节流形同虚设')
  db.close()
})

test('没有源到点时 tick 直接跳过，连锁都不拿：interval 720 的源不该每分钟被叫醒一次', () => {
  const db = dbOf()
  upsertSource(db, { id: 'slow', type: 'rss', url: 'https://e.com/f', enabled: true, interval_min: 720, weight: 1 })
  setSourceResult(db, 'slow', { ok: true, at: at('08:00') })
  let fired = 0
  const lines = []
  const lockFile = path.join(dirOf(), 'run.lock')
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }), runOnce: async () => { fired++; return { runId: 1, status: 'done', stats: {} } },
    now: () => at('08:05'), log: (e) => lines.push(e), lockFile
  })
  assert.deepEqual(s.tick(), { skipped: true, why: 'idle' })
  assert.equal(fired, 0, '没到点就不该开轮')
  assert.equal(fs.existsSync(lockFile), false, '空转连锁都不该拿')
  assert.deepEqual(lines, [], '空转也不该留日志——一天 288 次 tick，记一行就等于把噪音搬进日志')
  // 12 小时后到点，照常跑（这次把时段窗放开，免得 window 先把它挡掉——测的是节流，不是窗）
  const open = { schedule: { windows: [], max_per_run: 10 } }
  const s2 = createScheduler({
    db, getPref: () => ({ pref: open, errors: [] }), runOnce: async () => { fired++; return { runId: 2, status: 'done', stats: {} } },
    now: () => at('08:00') + 12 * 3600000, log: () => {}, lockFile
  })
  assert.deepEqual(s2.tick(), { skipped: false })
  assert.equal(fired, 1)
  db.close()
})

test('runOnce 抛异常时不留下卡死的锁，下一次还能跑', async () => {
  const lockFile = path.join(dirOf(), 'run.lock')
  const db = dbOf()
  let n = 0
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }),
    runOnce: async () => { n++; if (n === 1) throw new Error('炸了'); return { runId: n, status: 'done', stats: {} } },
    now: () => at('08:00'), log: (e) => e, lockFile
  })
  const first = await s.triggerNow()
  assert.equal(first.skipped, true)
  assert.equal(first.why, 'crash')
  assert.equal(fs.existsSync(lockFile), false, '异常后锁没释放')
  const second = await s.triggerNow()
  assert.equal(second.skipped, false)
  assert.equal(n, 2)
  db.close()
})

test('陈旧锁（pid 不存在）会被接管，不会永久挡住调度', async () => {
  const lockFile = path.join(dirOf(), 'run.lock')
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, since: Date.now() - 900000 }))
  const db = dbOf()
  let n = 0
  const s = createScheduler({ db, getPref: () => ({ pref, errors: [] }), runOnce: async () => ({ runId: ++n, status: 'done', stats: {} }), now: () => at('08:00'), log: () => {}, lockFile })
  const r = await s.triggerNow()
  assert.equal(r.skipped, false)
  assert.equal(n, 1)
  assert.equal(fs.existsSync(lockFile), false)
  db.close()
})

test('tick 在窗外只登记不抓取；start 用注入的 interval 且不立刻跑', () => {
  const db = dbOf()
  let n = 0
  const started = []
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }), runOnce: async () => ({ runId: ++n, status: 'done', stats: {} }),
    now: () => at('20:00'), log: () => {}, tickMin: 1, lockFile: path.join(dirOf(), 'run.lock'),
    setInterval: (fn, ms) => { started.push(ms); return { fn, ms } },
    clearInterval: () => { started.push('cleared') }
  })
  assert.deepEqual(s.tick(), { skipped: true, why: 'window' })
  assert.equal(n, 0)
  const handle = s.start()
  assert.deepEqual(started, [60000])
  assert.equal(handle.ms, 60000)
  s.stop(handle)
  assert.deepEqual(started, [60000, 'cleared'])
  db.close()
})
