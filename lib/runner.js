import { adapterFor } from './adapters/index.js'
import { runJobs } from './pool.js'
import { normalize } from './normalize.js'
import { putDraft } from './dedup.js'
import { gate, summarizeGaps } from './prefilter.js'
import { planJobs, syncSources } from './jobs.js'
import { createRun, finishRun, setCursor, setSourceResult, setStatus, isCollected, knownExternalIds, listSources } from './store.js'

export { planJobs, syncSources }

/**
 * 一轮摄取：计划 → 抓取 → 归一 → 去重 → 预筛 → 记账。
 * 不做判断（那是 M3 的 headless 会话），不碰网络细节（那是适配器），不改偏好。
 *
 * 两条必须成立的性质：
 *  1. **失败不推进游标**：只有成功的源才 setCursor，失败源下一轮自动补上缺口。
 *  2. **丢弃必须留痕**：预筛丢弃与"带标记保留"都进 stats.gaps，汇报区靠它写诚实的那一行。
 */
export async function runOnce({ db, pref, now = Date.now, log = () => {}, fetchImpl, adapters, trigger = 'schedule', force = false } = {}) {
  const at = now()

  syncSources(db, pref)
  const jobs = planJobs({ db, now: () => at, force })

  // 有源、但一个都不到点：这一轮根本没发生，不该在库里留一条空轮记录。
  // 此前每 5 分钟开一轮、跑完发现无事可做——库里 102 轮有 86 条 partial 全是这么来的。
  // 返回 idle 而不是 done：done 是"跑了一轮、结果为空"，idle 是"这一轮没跑"。
  // 一个源都没启用时不走这里，照旧记 done——否则新装好的插件会亮假红点。
  if (jobs.length === 0 && listSources(db).some(s => s.enabled === 1)) {
    log({ at, level: 'info', event: 'run_idle', detail: '没有源到点', trigger })
    return { runId: null, status: 'idle' }
  }

  const runId = createRun(db, trigger, () => at)
  const emit = (level, event, detail, source_id) => log({ at: now(), level, event, detail, source_id, run_id: runId })
  emit('info', 'run_start', `${jobs.length} 个源排队`)

  const results = await runJobs(jobs, {
    limit: 4,
    timeoutMs: 20000,
    retries: 1,
    run: async (job, { signal } = {}) => {
      const adapter = adapters?.[job.type] ?? adapterFor(job.type)
      if (!adapter) {
        const e = new Error(`未注册的适配器类型 ${job.type}`)
        e.parse = true
        throw e
      }
      const id = job.source.id
      // knownIds：该源已入库的 external_id 集合，只读注入（M4b Task 3）。bili/yt 的 flat
      // 列表每轮都是最新 30 条、适配器无法自辨新旧，不注入就是对全部条目重跑 detail+字幕；
      // 适配器消费集合但不碰库（红线不破）；rss 不理会这个键（refreshItem 的内容更新
      // 语义依赖全量返回）。
      const knownIds = knownExternalIds(db, id)
      const items = await adapter.fetch(job.source, {
        since: job.since,
        // pool 超时即 abort：signal 原样给适配器，超时后它在飞的 fetch 才断得掉（孤儿调用消失）
        signal,
        fetchImpl,
        now,
        pref,
        knownIds,
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
