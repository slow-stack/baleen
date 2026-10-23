import { stripTags, cleanUrl } from './feed.js'

const FULL_MIN_CHARS = 400
const reCache = new Map()
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 关键词命中判断。三层规则，每一层都是被真数据打出来的：
 *  - 非 ASCII（中文）→ 子串匹配，中文没有词边界。
 *  - 纯 ASCII 全小写（`agent`、`mcp`）→ 词边界 + 不区分大小写。
 *  - 纯 ASCII 含大写（`React`、`CSS`、`UI`、`MCP`）→ 词边界 + **区分大小写**：
 *    她写成大写就是要指专名，散文里的 "how we react to" 不该被当成命中框架 React；
 *    上一版不区分大小写时正是这么造假理由的。
 */
function kwHit(hayLower, hayRaw, kw) {
  const k = String(kw ?? '').trim()
  if (!k) return false
  if (!/^[\x00-\x7F]+$/.test(k)) return hayLower.includes(k.toLowerCase())
  const caseSensitive = k !== k.toLowerCase()
  const key = (caseSensitive ? 'S:' : 'I:') + k
  let re = reCache.get(key)
  if (!re) {
    const word = caseSensitive ? k : k.toLowerCase()
    const edge = caseSensitive ? '[^A-Za-z0-9]' : '[^a-z0-9]'
    re = new RegExp(`(^|${edge})${escRe(word)}($|${edge})`, caseSensitive ? '' : 'i')
    reCache.set(key, re)
  }
  return re.test(caseSensitive ? hayRaw : hayLower)
}

/**
 * 拿到的是全文、摘要、字幕、还是根本没内容——这个字段是面板诚实度的根。
 * missing（无语音）与 burned_in（字烧在画面上）绝不能合成一个值。
 */
export function inferBodyState(raw) {
  if (raw.subtitle_text) return 'subtitle'
  if (raw.transcribed_text) return 'transcribed'
  const full = stripTags(raw.body_html)
  const sum = stripTags(raw.summary_html)
  if (full.length >= FULL_MIN_CHARS && full.length >= sum.length * 1.4) return 'full'
  if (sum.length || full.length) return 'summary_only'
  if (raw.hardsub_hint) return 'burned_in'
  return 'missing'
}

export function inferKind(source, raw) {
  if (raw.note_type === 'video') return 'video'
  if (raw.note_type === 'image') return 'note'
  if (source?.type === 'bili' || source?.type === 'yt') return 'video'
  if (Number.isFinite(raw.duration_sec) && raw.duration_sec > 0) return 'video'
  return 'article'
}

/**
 * 纯字符串命中判断：不做权重、不看时间，只回答"沾不沾边、有没有被排除词判死"。
 * never 与 redlines 命中即 rejected —— 它们优先于任何加分。
 */
export function matchThemes(text, pref) {
  const raw = String(text ?? '')
  const hay = raw.toLowerCase()
  const hitKeywords = []
  const groups = []
  let score = 0
  for (const t of pref?.themes ?? []) {
    const w = Number.isFinite(t.weight) ? t.weight : 1
    const never = (t.never ?? []).filter(k => kwHit(hay, raw, k))
    if (never.length) return { rejected: true, reason: `never「${never[0]}」`, hitKeywords: [], groups: [], score: 0 }
    const mustList = (t.must ?? []).filter(Boolean)
    const mustOk = mustList.every(k => kwHit(hay, raw, k))
    const anyHits = (t.any ?? []).filter(k => kwHit(hay, raw, k))
    if (!mustOk || !anyHits.length) continue
    for (const k of [...mustList, ...anyHits]) if (!hitKeywords.includes(k)) hitKeywords.push(k)
    groups.push(t.group)
    score += w * (mustList.length ? 1 : 0.5) + anyHits.length * 0.2 * w
  }
  const redline = (pref?.redlines ?? []).find(k => kwHit(hay, raw, k))
  if (redline) return { rejected: true, reason: `redline「${redline}」`, hitKeywords: [], groups: [], score: 0 }
  const reason = hitKeywords.length
    ? `命中 ${hitKeywords.slice(0, 3).join(' / ')}${groups.length ? `（${groups.join('、')}）` : ''}`
    : '未命中任何主题组'
  return { rejected: false, reason, hitKeywords, groups, score: Math.round(score * 100) / 100 }
}

/**
 * RawItem + source + pref → items 表的行（列名与 DDL 严格一致，不多不少）。
 * 输出可直接插库：判断与预筛需要的额外信息都塞在 match_json 里，不污染列。
 */
export function normalize(raw, source, pref, now = Date.now) {
  const haystack = [raw.title, (raw.tags ?? []).join(' '), stripTags(raw.body_html ?? ''), stripTags(raw.summary_html ?? '')]
    .filter(Boolean).join('\n')
  const m = matchThemes(haystack, pref)
  const srcWeight = Number.isFinite(source?.weight) ? source.weight : 1
  const delta = pref?.tuning?.source_delta?.[raw.source_id] ?? 0
  const srcUrl = cleanUrl(source?.url)
  const followed = !!srcUrl && (pref?.follow?.feeds ?? []).some(f => cleanUrl(f) === srcUrl)
  const score_follow = followed ? 0.6 : 0
  const bodyText = stripTags(raw.body_html ?? raw.summary_html ?? '')

  return {
    source_id: raw.source_id,
    external_id: raw.external_id ?? raw.url,
    kind: inferKind(source, raw),
    title: String(raw.title ?? '').slice(0, 300),
    url: raw.url ?? `x-baleen://stub/${raw.source_id}/${raw.external_id ?? ''}`,
    author: raw.author ?? null,
    author_id: raw.author_id ?? null,
    published_at: raw.published_at ?? null,
    time_estimated: raw.published_at == null ? 1 : 0,
    fetched_at: raw.fetched_at ?? now(),
    thumb: raw.thumb ?? null,
    duration_sec: raw.duration_sec ?? null,
    stats_json: raw.stats ? JSON.stringify(raw.stats) : null,
    tags_json: raw.tags?.length ? JSON.stringify(raw.tags) : null,
    locale: raw.locale ?? null,
    body_text: bodyText || null,
    body_state: inferBodyState(raw),
    match_json: JSON.stringify({
      hitKeywords: m.hitKeywords,
      groups: m.groups,
      reason: m.reason,
      weight: Math.round((srcWeight + delta) * 100) / 100,
      score_theme: m.score,
      score_follow,
      followed,
      rejected: m.rejected
    }),
    prefilter_score: Math.round((m.score + score_follow + srcWeight + delta) * 100) / 100,
    status: 'new'
  }
}
