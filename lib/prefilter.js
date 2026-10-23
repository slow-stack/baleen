export const REASONS = ['theme-reject', 'no-body', 'stale', 'too-short', 'skip-kind', 'below-score', 'no-match']

const DAY = 86400000
const DEFAULTS = { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] }
const MIN_SCORE_DEFAULT = 0.2

function fail(reason, detail) { return { pass: false, reason, detail } }

/**
 * 预筛是**不调模型**的那道闸：全部规则可解释、零成本，
 * 它存在的意义就是把进入判断轮的量压下来（判断按 token 付钱，按条数预算）。
 *
 * 两个刻意不对称：
 *  - `missing`（读不到内容）丢弃，`burned_in`（硬字幕）保留并打标记——
 *    把后者丢掉就等于对用户谎报"这条没内容"。
 *  - `summary_only` 放行——Medium 付费墙是常态，不是劣质。
 */
export function gate(draft, pref, now = Date.now) {
  const limits = { ...DEFAULTS, ...(pref?.limits ?? {}) }
  const minScore = Number.isFinite(pref?.min_score) ? pref.min_score : MIN_SCORE_DEFAULT
  const needTheme = pref?.require_theme_hit !== false

  let match = {}
  try { match = JSON.parse(draft.match_json ?? '{}') ?? {} } catch { match = {} }

  if (match.rejected) return fail('theme-reject', match.reason || '命中排除词')
  if (limits.skip_kinds.includes(draft.kind)) return fail('skip-kind', `kind=${draft.kind}`)
  if (draft.body_state === 'missing') return fail('no-body', '读不到内容')
  if (draft.published_at != null) {
    const age = Number(now()) - Number(draft.published_at)
    if (age > limits.max_age_days * DAY) return fail('stale', `${Math.floor(age / DAY)} 天前`)
  }
  if (draft.kind === 'video' && Number.isFinite(draft.duration_sec) && draft.duration_sec < limits.min_duration_sec) {
    return fail('too-short', `${draft.duration_sec}s < ${limits.min_duration_sec}s`)
  }
  if (Number(draft.prefilter_score ?? 0) < minScore) return fail('below-score', String(draft.prefilter_score ?? 0))
  /**
   * 必须有主题命中（或那是关注源）才进候选。
   * 老 bug：prefilter_score 里含来源权重，于是"启用一个源"= "它的全部内容都进候选"，
   * 实测一轮 80 条里 56 条进候选、其中大量一条主题都没命中——那就不是"按我的偏好找"了。
   * 只在字段**明确为空数组**时丢弃：match_json 解析失败（{}）不算"没命中"，
   * 否则一个坏掉的 JSON 会把内容静默吞掉。
   */
  const noTheme = Array.isArray(match.hitKeywords) && match.hitKeywords.length === 0 && match.followed === false
  if (needTheme && noTheme) return fail('no-match', '没命中主题，也不是关注的源')
  if (draft.body_state === 'burned_in') return { pass: true, keep_flag: 'burned_in' }
  return { pass: true }
}

/**
 * 把一轮的丢弃/保留标记汇总成一行可展示的统计。
 * 汇报区必须有这一行，否则"因无字幕跳过 4 条"就会悄悄消失。
 */
export function summarizeGaps(entries) {
  const by_reason = {}
  const kept_with_flag = {}
  let total_dropped = 0
  for (const e of entries ?? []) {
    if (e.keep) {
      kept_with_flag[e.reason] = (kept_with_flag[e.reason] ?? 0) + 1
      continue
    }
    by_reason[e.reason] = (by_reason[e.reason] ?? 0) + 1
    total_dropped++
  }
  return { by_reason, kept_with_flag, total_dropped }
}
