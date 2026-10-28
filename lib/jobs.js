import { listSources, getCursor, upsertSource } from './store.js'

/**
 * 把 preference.yaml 的 sources 镜像进 sources 表。
 * 偏好是真源，表是运行态（游标、上次成败）——所以这里只 upsert 配置列，
 * 绝不删行、绝不碰 cursor / last_error / last_ok_at。
 */
export function syncSources(db, pref) {
  for (const s of pref?.sources ?? []) upsertSource(db, s)
}

/** 节流的粒度：分钟。与 sources.interval_min 同一单位。 */
const MINUTE = 60000

/**
 * 这个源到点了吗？看 last_attempt_at（成功失败都写）而不是 last_ok_at——
 * 一个一直失败的源若只看"上次成功"，会永远到点，等于没节流。
 * 没有 last_attempt_at 视为从没试过 → 放行（首轮该全抓）。
 */
function dueByInterval(source, at) {
  const last = Number(source?.last_attempt_at)
  if (!Number.isFinite(last) || last <= 0) return true
  const interval = Number.isInteger(source?.interval_min) ? source.interval_min : 720
  // 0 / 负数不节流：配置层不许（preference.js 要求 ≥15），但库里被手改成 0 时不该永久停摆。
  if (interval <= 0) return true
  return at - last >= interval * MINUTE
}

/**
 * 有没有源到点？给调度器一个便宜的"现在该不该开这一轮"的判断。
 * 一个启用的源都没有时返回 false：没源可抓就没什么可跑的，定时器不该每 5 分钟
 * 记一条空 done。直接调 runOnce（真机上不会有这条路）仍照旧记 done，
 * 那是"跑了一轮、结果为空"的语义，不是空转。
 */
export function anyDue({ db, now = Date.now }) {
  const at = Number(now())
  const enabled = listSources(db).filter(s => s.enabled === 1)
  return enabled.some(s => dueByInterval(s, at))
}

/**
 * 每个启用的源一个 job。
 * since = 该源上次**成功**那轮的窗口终点（ISO → ms）；没成功过就是 null（全量首抓）。
 * windowEnd 在计划时就定下，成功后才写回游标——失败不推进就靠这一对。
 */
export function planJobs({ db, now = Date.now, force = false }) {
  const windowEnd = Number(now())
  return listSources(db)
    .filter(s => s.enabled === 1)
    // force 只给手动触发用：用户点"现在跑一轮"就是"我现在要"，不拿间隔挡他。
    // 定时轮不 force——没到点就该什么都不做，而不是每 5 分钟开一轮空轮。
    .filter(s => force || dueByInterval(s, windowEnd))
    .map(s => {
      const iso = getCursor(db, s.id)
      const ms = iso ? Date.parse(iso) : NaN
      const job = { source: s, type: s.type, since: Number.isFinite(ms) ? ms : null, windowEnd }
      // bili / yt 的逐条流程天然长：bili 是 nav + wbi 签名 + 列表 + 每条增量一次 view；
      // yt 是 flat 列表 + 每条两次 yt-dlp（dump-single-json + 字幕轨落盘，一条 ≈2-6s）。
      // 通用 20s 在真机 run 17 上跑不完（run_end 之后适配器还在打 detail——孤儿调用）。
      // 更宽的预算配 pool 的"超时即 abort"：真超了也断得干净，不白烧配额不顶风控。
      if (s.type === 'bili' || s.type === 'yt') job.timeout_ms = 90000
      return job
    })
}
