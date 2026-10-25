import { adapterFor } from './adapters/index.js'
import { runJobs } from './pool.js'
import { normalize } from './normalize.js'
import { putDraft } from './dedup.js'
import { gate, summarizeGaps } from './prefilter.js'
import { planJobs, syncSources } from './jobs.js'
import { createRun, finishRun, setCursor, setSourceResult, setStatus, isCollected } from './store.js'

export { planJobs, syncSources }

/**
 * 一轮摄取：计划 → 抓取 → 归一 → 去重 → 预筛 → 记账。
 * 不做判断（那是 M3 的 headless 会话），不碰网络细节（那是适配器），不改偏好。
 *
 * 两条必须成立的性质：
 *  1. **失败不推进游标**：只有成功的源才 setCursor，失败源下一轮自动补上缺口。
 *  2. **丢弃必须留痕**：预筛丢弃与"带标记保留"都进 stats.gaps，汇报区靠它写诚实的那一行。
 */
export async function runOnce({ db, pref, now = Date.now, log = () => {}, fetchImpl, adapters, trigger = 'schedule' } = {}) {
  const at = now()
  const runId = createRun(db, trigger, () => at)
  const emit = (level, event, detail, source_id) => log({ at: now(), level, event, detail, source_id, run_id: runId })

  syncSources(db, pref)
  // bili 是子进程源：适配器自带 60s 子进程上限 + kill，这里给 70s 是让适配器自己先报准信儿，
  // 别让 pool 的通用 20s 预算把它掐死在半程（首次全量 30 条 detail 时尤其要命）。
  const jobs = planJobs({ db, pref, now: () => at }).map(j => (j.type === 'bili' ? { ...j, timeout_ms: 70000 } : j))
  emit('info', 'run_start', `${jobs.length} 个源排队`)

  const results = await runJobs(jobs, {
    limit: 4,
    timeoutMs: 20000,
    retries: 1,
    run: async (job) => {
      const adapter = adapters?.[job.type] ?? adapterFor(job.type)
      if (!adapter) {
        const e = new Error(`未注册的适配器类型 ${job.type}`)
        e.parse = true
        throw e
      }
      const id = job.source.id
      const items = await adapter.fetch(job.source, {
        since: job.since,
        fetchImpl,
        now,
        pref,
        log: (event, detail) => emit('info', event, String(detail ?? '').slice(0, 200), id)
      })
      return { items, windowEnd: job.windowEnd }
    }
  })

  const stats = { fetched: 0, inserted: 0, updated: 0, duplicate: 0, archived: 0, candidates: 0, held: 0, gaps: [], per_source: {} }
  const gapLog = []

  for (const r of results) {
    const id = r.job.source.id
    if (!r.ok) {
      stats.per_source[id] = { ok: false, fetched: 0, error_class: r.error_class }
      setSourceResult(db, id, { ok: false, error_class: r.error_class, error: String(r.error?.message ?? r.error).slice(0, 200), at: now() })
      emit('warn', 'source_failed', `${r.error_class}：${String(r.error?.message ?? '').slice(0, 120)}`, id)
      continue
    }

    const items = r.value.items ?? []
    const source = r.job.source
    // 该源的过期窗覆盖全局值；没设就用全局
    const effPref = Number.isInteger(source.max_age_days)
      ? { ...pref, limits: { ...(pref?.limits ?? {}), max_age_days: source.max_age_days } }
      : pref
    const backlog = r.job.since == null
    const local = { fetched: items.length, inserted: 0, updated: 0, duplicate: 0, archived: 0, candidates: 0, held: 0 }
    for (const raw of items) {
      let draft
      try {
        draft = normalize({ ...raw, source_id: source.id, fetched_at: raw.fetched_at ?? at }, source, effPref, now)
      } catch (e) {
        gapLog.push({ reason: 'no-body', detail: '归一失败' })
        emit('warn', 'normalize_failed', String(e?.message ?? e).slice(0, 120), id)
        continue
      }
      const put = putDraft(db, draft, now)
      if (put.action === 'insert') local.inserted++
      else if (put.action === 'update') local.updated++
      else if (put.action === 'duplicate') local.duplicate++
      if (put.action === 'skip_seen') continue

      const g = gate(draft, effPref, now, { backlog })
      if (!g.pass) {
        // 收藏 = 钉住（D15）：收过的条目这轮没过闸也不改归档，且每次都现读关系表，
        // 所以移出夹之后下一轮照旧被清理——豁免不是给条目发免死牌。
        // duplicate 那条路径不动：去重归档的是多出来的冗余副本，留下的本来就是被收的那一份。
        if (put.action !== 'duplicate' && !isCollected(db, put.id)) {
          setStatus(db, put.id, 'archived', `${g.reason}:${g.detail ?? ''}`)
          local.archived++
          gapLog.push({ reason: g.reason, detail: g.detail })
        } else if (put.action !== 'duplicate') {
          // 真的因收藏豁免：丢弃没发生，也不进 by_reason（那会谎报一次没发生的丢弃），
          // 只记一枚「收藏钉住」计数，让汇报看得见"今天有 N 条因收藏未清理"。
          local.held++
        }
        continue
      }
      if (g.keep_flag) gapLog.push({ reason: g.keep_flag, keep: true })
      local.candidates++
    }

    for (const k of ['fetched', 'inserted', 'updated', 'duplicate', 'archived', 'candidates', 'held']) stats[k] += local[k]
    stats.per_source[id] = { ok: true, ...local }
    // 只有成功才推进游标，且推进到本轮的窗口终点
    setCursor(db, id, new Date(r.value.windowEnd).toISOString())
    setSourceResult(db, id, { ok: true, at: now() })
    emit('info', 'source_ok', `抓 ${local.fetched} → 候选 ${local.candidates}（丢弃 ${local.archived}）`, id)
  }

  stats.gaps = summarizeGaps(gapLog)
  // held 挂进 gaps 才能活到面板：finishRun 只持久化 {status, candidates, gaps, per_source}。
  stats.gaps.held = stats.held
  const okCount = Object.values(stats.per_source).filter(s => s.ok).length
  // 没有 job 可跑 ≠ 失败：偏好里一个源都没启用（或都被禁用）时记 done，
  // 否则新装好的插件会在面板上亮起"上一轮失败"的红点，而它其实什么都没做错。
  const status = results.length === 0 ? 'done' : okCount === 0 ? 'failed' : okCount < results.length ? 'partial' : 'done'
  finishRun(db, runId, { status, candidates: stats.candidates, gaps: stats.gaps, per_source: stats.per_source }, () => now())
  emit(status === 'done' ? 'info' : 'warn', 'run_end', `${status}：抓 ${stats.fetched}，候选 ${stats.candidates}，丢弃 ${stats.gaps.total_dropped}`, null)

  const { per_source, ...rest } = stats
  return { runId, status, stats: { ...rest, per_source } }
}
