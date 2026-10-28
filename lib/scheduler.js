import fs from 'node:fs'
import path from 'node:path'
import { lastRun } from './store.js'
import { anyDue } from './jobs.js'
import { ensureHome } from './paths.js'

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
const MINUTE = 60000

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * 时段窗判断（支持跨零点，比如 18:00-09:00）。
 * 空窗＝不限时段；写错的窗**忽略**而不是抛——偏好是用户手写的，
 * 一个笔误不该让插件起不来，但会因为偏好校验层已经把格式拦过一次，这里属于第二道防线。
 */
export function withinWindow(windows, dateLike) {
  if (!windows?.length) return true
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  const cur = d.getHours() * 60 + d.getMinutes()
  return windows.some(w => {
    if (typeof w !== 'string' || !WINDOW_RE.test(w)) return false
    const [s, e] = w.split('-').map(toMin)
    return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)
  })
}

export function dueReason({ db, pref, now = Date.now, running = false, minGapMs = 2 * MINUTE }) {
  const at = Number(now())
  // off_peak_only 是时段窗的开关：关掉它 = 抓取不再受窗口限制（偏好里那两行窗口还在，
  // 只是不再拦）。缺省按 true 走（spec §12：默认开）。不读这个字段的话，设置页那个
  // "只在时间窗内抓"的复选框就是个装饰——勾不勾都一样。
  const gateByWindow = pref?.schedule?.off_peak_only !== false
  if (gateByWindow && !withinWindow(pref?.schedule?.windows ?? [], new Date(at))) return 'window'
  if (running) return 'running'
  const prev = lastRun(db)
  if (prev?.started_at && at - Number(prev.started_at) < minGapMs) return 'too-soon'
  return null
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 单实例调度。锁是"内存 busy + 磁盘 run.lock（带 pid）"两层：
 * 内存挡同一进程内的并发轮，磁盘 pid 挡进程被强杀后留下的陈旧锁——
 * pid 已经不在了就接管，绝不因为一次崩溃就永久哑掉。
 * 跑完 / 抛异常都在 finally 释放锁，异常还会上报 run_crash。
 */
export function createScheduler({
  db, getPref, runOnce, now = Date.now, log = () => {}, tickMin = 5, lockFile, minGapMs,
  setInterval: setIntervalImpl = setInterval, clearInterval: clearIntervalImpl = clearInterval
}) {
  const lock = lockFile ?? path.join(ensureHome(), 'run.lock')
  let busy = false

  function acquire() {
    const cur = readLock(lock)
    if (cur && pidAlive(cur.pid)) return false
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: now() }), 'utf8')
    return true
  }

  async function fire(trigger) {
    if (busy) {
      log({ at: now(), level: 'info', event: 'skipped', detail: `已有${trigger === 'manual' ? '手动' : '定时'}轮在跑`, trigger })
      return { skipped: true, why: 'running' }
    }
    busy = true
    let locked = false
    try {
      if (!acquire()) {
        log({ at: now(), level: 'warn', event: 'skipped_lock', detail: '别的进程持有 run.lock', trigger })
        return { skipped: true, why: 'lock' }
      }
      locked = true
      const { pref, errors } = getPref()
      if (errors?.length) {
        log({ at: now(), level: 'error', event: 'preference_invalid', detail: errors.join(' | ') })
        return { skipped: true, why: 'preference', errors }
      }
      // 手动触发带 force：用户点"现在跑一轮"是"我现在要"，不拿 interval_min 挡他。
      const out = await runOnce({ db, pref, now, log, trigger, force: trigger === 'manual' })
      return { skipped: false, ...out }
    } catch (e) {
      log({ at: now(), level: 'error', event: 'run_crashed', detail: String(e?.message ?? e).slice(0, 200) })
      return { skipped: true, why: 'crash' }
    } finally {
      busy = false
      if (locked) {
        try { fs.rmSync(lock, { force: true }) } catch { /* 释放失败下次靠 pid 判定接管 */ }
      }
    }
  }

  function tick() {
    const { pref, errors } = getPref()
    if (errors?.length) return { skipped: true, why: 'preference' }
    const why = dueReason({ db, pref, now, running: busy, minGapMs })
    if (why) {
      if (why !== 'window') log({ at: now(), level: 'info', event: 'not_due', detail: why })
      return { skipped: true, why }
    }
    // 一个源都没到点：连 fire 都不开。否则每 5 分钟都要拿一次锁、跑一遍空轮、
    // 再往 diagnostics 里写一行——interval_min 720 的源，一天里 143 次 tick 有 142 次是这种。
    if (!anyDue({ db, now })) {
      log({ at: now(), level: 'info', event: 'not_due', detail: 'idle' })
      return { skipped: true, why: 'idle' }
    }
    fire('schedule')
    return { skipped: false }
  }

  return {
    tick,
    triggerNow: () => fire('manual'),
    start() {
      const ms = Math.max(1, tickMin) * MINUTE
      const handle = setIntervalImpl(() => tick(), ms)
      return { handle, ms }
    },
    stop(handle) { if (handle?.handle) clearIntervalImpl(handle.handle) }
  }
}
