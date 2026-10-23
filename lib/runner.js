import { adapterFor } from './adapters/index.js'
import { runJobs } from './pool.js'
import { normalize } from './normalize.js'
import { putDraft } from './dedup.js'
import { gate, summarizeGaps } from './prefilter.js'
import { planJobs, syncSources } from './jobs.js'
import { createRun, finishRun, setCursor, setSourceResult, setStatus } from './store.js'

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
  const jobs = planJobs({ db, pref, now: () => at })
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
      const items = await adapter.fetch(job.source, { since: job.since, fetchImpl, now })
      return { items, windowEnd: job.windowEnd }
    }
  })

  const stats = { fetched: 0, inserted: 0, updated: 0, duplicate: 0, archived: 0, candidates: 0, gaps: [], per_source: {} }
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
    const local = { fetched: items.length, inserted: 0, updated: 0, duplicate: 0, archived: 0, candidates: 0 }
    for (const raw of items) {
      const source = r.job.source
      let draft
      try {
        draft = normalize({ ...raw, source_id: source.id, fetched_at: raw.fetched_at ?? at }, source, pref, now)
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

      const g = gate(draft, pref, now)
      if (!g.pass) {
        if (put.action !== 'duplicate') {
          setStatus(db, put.id, 'archived', `${g.reason}:${g.detail ?? ''}`)
          local.archived++
          gapLog.push({ reason: g.reason, detail: g.detail })
        }
        continue
      }
      if (g.keep_flag) gapLog.push({ reason: g.keep_flag, keep: true })
      local.candidates++
    }

    for (const k of ['fetched', 'inserted', 'updated', 'duplicate', 'archived', 'candidates']) stats[k] += local[k]
    stats.per_source[id] = { ok: true, ...local }
    // 只有成功才推进游标，且推进到本轮的窗口终点
    setCursor(db, id, new Date(r.value.windowEnd).toISOString())
    setSourceResult(db, id, { ok: true, at: now() })
    emit('info', 'source_ok', `抓 ${local.fetched} → 候选 ${local.candidates}（丢弃 ${local.archived}）`, id)
  }

  stats.gaps = summarizeGaps(gapLog)
  const okCount = Object.values(stats.per_source).filter(s => s.ok).length
  // 没有 job 可跑 ≠ 失败：偏好里一个源都没启用（或都被禁用）时记 done，
  // 否则新装好的插件会在面板上亮起"上一轮失败"的红点，而它其实什么都没做错。
  const status = results.length === 0 ? 'done' : okCount === 0 ? 'failed' : okCount < results.length ? 'partial' : 'done'
  finishRun(db, runId, { status, candidates: stats.candidates, per_source: stats.per_source }, () => now())
  emit(status === 'done' ? 'info' : 'warn', 'run_end', `${status}：抓 ${stats.fetched}，候选 ${stats.candidates}，丢弃 ${stats.gaps.total_dropped}`, null)

  const { per_source, ...rest } = stats
  return { runId, status, stats: { ...rest, per_source } }
}
