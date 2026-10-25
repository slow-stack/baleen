import { listSources, getCursor, upsertSource } from './store.js'

/**
 * 把 preference.yaml 的 sources 镜像进 sources 表。
 * 偏好是真源，表是运行态（游标、上次成败）——所以这里只 upsert 配置列，
 * 绝不删行、绝不碰 cursor / last_error / last_ok_at。
 */
export function syncSources(db, pref) {
  for (const s of pref?.sources ?? []) upsertSource(db, s)
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
    .map(s => {
      const iso = getCursor(db, s.id)
      const ms = iso ? Date.parse(iso) : NaN
      const job = { source: s, type: s.type, since: Number.isFinite(ms) ? ms : null, windowEnd }
      // bili 的逐条流程天然长：nav + wbi 签名 + 列表 + 每条增量一次 view（一条 ≈1-3s），
      // 通用 20s 在真机 run 17 上跑不完（run_end 之后适配器还在打 detail——孤儿调用）。
      // 更宽的预算配 pool 的"超时即 abort"：真超了也断得干净，不白烧配额不顶风控。
      if (s.type === 'bili') job.timeout_ms = 90000
      return job
    })
}
