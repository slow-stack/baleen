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
  if (interval <= 0) return true
  return at - last >= interval * MINUTE
}

/**
 * 每个启用的源一个 job。
 * since = 该源上次**成功**那轮的窗口终点（ISO → ms）；没成功过就是 null（全量首抓）。
 * windowEnd 在计划时就定下，成功后才写回游标——失败不推进就靠这一对。
 */
export function planJobs({ db, pref, now = Date.now }) {
  const windowEnd = Number(now())
  return listSources(db)
    .filter(s => s.enabled === 1)
    .filter(s => dueByInterval(s, windowEnd))
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
