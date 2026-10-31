import { getXhsMcp } from '../mcp/xhs-client.js'

export const type = 'xhs'

/**
 * xhs 适配器 —— 小红书搜索关键词 → 笔记列表 → 逐条详情，经官方 MCP（HTTP，见
 * lib/mcp/xhs-client.js）。选型与边界见 docs/v3-xhs-mcp-audit.md（V3）与 M6 计划：
 *
 * 边界（AGENTS.md 适配器红线，与 bili/yt 同款）：
 *  - 只读：search_feeds / get_feed_detail / check_login_status 全是查询，写工具
 *    在 client 白名单就被拒（红线之下的第二道闸）；
 *  - 不判断、不写库：产出 RawItem，增量判定交给 putDraft 去重、backlog 交给 gate；
 *  - 零重试：本层从不重试，失败上抛交 pool 分类（needs_login / mcp_missing /
 *    xhs_risk 各自钉 error_class，游标不推进）。
 */

/** 每轮新条目上限（与 bili/yt 同款）：预算分批不是丢，游标语义对齐。 */
const MAX_NEW_PER_RUN = 12
/** 详情并发 2：小红书风控比 B 站敏感，礼貌优先；job 预算 90s 兜得住。 */
const DETAIL_CONCURRENCY = 2

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}

async function mapLimit(list, limit, fn) {
  const results = new Array(list.length)
  let next = 0
  let broken = null
  async function worker() {
    while (broken === null) {
      const i = next++
      if (i >= list.length) return
      try {
        results[i] = await fn(list[i], i)
      } catch (e) {
        broken = e
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  if (broken !== null) throw broken
  return results
}

/** 互动数是小红书给的展示字符串（"26826"，偶尔带分隔），能解析就给数字，解析不了给 null 不编数。 */
function parseCount(s) {
  const n = Number(String(s ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 笔记详情页地址。xsec_token 是详情接口的入场券（搜索结果自带），随 URL 保全。 */
export function noteUrl(id, xsecToken) {
  const q = new URLSearchParams({ xsec_token: String(xsecToken ?? ''), xsec_source: 'pc_search' })
  return `https://www.xiaohongshu.com/explore/${encodeURIComponent(String(id))}?${q}`
}

/**
 * fetchXhs(source, {…}) → RawItem[]
 * 源主键是 source.query（搜索关键词）；needs_login 是一等公民错误类：登录态过期
 * 本轮整源跳过，汇报里明写，不重试不静默。
 */
export async function fetchXhs(source, {
  signal,
  now = Date.now,
  pref = null,
  knownIds = null,
  log = () => {},
  mcp = null // 注入缝（测试/替身）；缺省走 getXhsMcp（惰性 spawn + 会话缓存）
} = {}) {
  // 关键词从 source.url 的 query 参数派生：sources 表只回传 url（与 bili 的 space URL
  // 同构），preference 里的 query 字段进不了表。两种写法都收（query 优先）。
  let keyword = String(source?.query ?? '').trim()
  try {
    const fromUrl = new URL(String(source?.url ?? '')).searchParams.get('query')
    if (!keyword && fromUrl && fromUrl.trim()) keyword = fromUrl.trim()
  } catch { /* url 不是合法 URL 时走 query 分支的报错 */ }
  if (!keyword) {
    throw fail('xhs 源解析不出搜索关键词——url 要形如 xiaohongshu.com/search?query=…', { error_class: 'bad_source' })
  }
  mcp = mcp ?? await getXhsMcp(pref, log)

  const login = await mcp.checkLoginStatus()
  if (!login.loggedIn) {
    throw fail('小红书未登录——本轮跳过；到 设置 → 凭据与环境 重新扫码', { error_class: 'needs_login' })
  }
  if (login.username) log('xhs_login_as', `登录态有效（${login.username}）`)

  const search = await mcp.searchFeeds(keyword)
  const feeds = Array.isArray(search?.feeds) ? search.feeds : []
  if (!feeds.length) {
    throw fail(`xhs 搜索 "${keyword}" 没有返回任何笔记——关键词太冷门或风控拦了，先在浏览器里搜一次核对`, { empty: true })
  }

  // 已入库跳过（纯内存过滤，发生在任何 detail 请求之前）+ 每轮上限（预算分批）。
  let fresh = feeds.filter((f) => f?.id)
  if (knownIds?.size) {
    const before = fresh.length
    fresh = fresh.filter((f) => !knownIds.has(String(f.id)))
    if (fresh.length < before) log('xhs_skipped_known', `${before - fresh.length} 条已入库，跳过详情`)
  }
  if (fresh.length > MAX_NEW_PER_RUN) {
    const deferred = fresh.length - MAX_NEW_PER_RUN
    fresh = fresh.slice(0, MAX_NEW_PER_RUN)
    log('xhs_deferred', `本轮只处理 ${MAX_NEW_PER_RUN} 条新笔记，${deferred} 条留待下轮`)
  }

  // 详情受限并发 2；单条详情失败只跳过该条（一条风控不该掀翻整源），needs_login 级
  // 的整源错误只可能发生在前面的探测与搜索阶段。
  const mapped = await mapLimit(fresh, DETAIL_CONCURRENCY, async (f) => {
    try {
      const detail = await mcp.getFeedDetail(String(f.id), String(f.xsecToken ?? ''))
      return toItem(detail, f, source, { now, signal })
    } catch (e) {
      log('xhs_item_skipped', `笔记 ${f.id} 详情失败被跳过：${String(e?.message ?? e).slice(0, 80)}`)
      return null
    }
  })
  return mapped.filter(Boolean)
}

/**
 * 详情 → RawItem。详情 JSON 的字段名以实机返回为准做防御式读取；detail 不可用时
 * 回落搜索卡片（列表里也有标题/作者/封面，只是没有正文——body_state 会如实降为 summary）。
 */
function toItem(detail, card, source, { now, signal }) {
  // 工具的返回可能是 {note: …} / {currentNote: …} / 直接是笔记本体，逐层兜。
  const note = detail?.note ?? detail?.currentNote ?? detail?.data?.note ?? (detail?.id ? detail : null)
  const noteCard = card?.noteCard ?? {}
  const interact = note?.interactInfo ?? noteCard.interactInfo ?? {}
  const user = note?.user ?? noteCard.user ?? {}
  const type = String(note?.type ?? noteCard.type ?? 'normal').toLowerCase()
  const id = String(note?.id ?? card?.id ?? '')
  if (!id) return null

  const video = note?.video ?? noteCard.video ?? null
  const durationSec = Number(video?.capa?.duration ?? video?.duration ?? NaN)
  const images = Array.isArray(note?.imageList) ? note.imageList : []
  const cover = noteCard.cover?.urlDefault || noteCard.cover?.url || images[0]?.urlDefault || images[0]?.url || null

  const desc = typeof note?.desc === 'string' ? note.desc : ''
  const title = String(note?.title ?? noteCard.displayTitle ?? '').trim()
  const timeMs = Number(note?.time ?? NaN)

  return {
    source_id: source.id,
    external_id: id,
    title: title || '（无标题）',
    url: noteUrl(id, note?.xsecToken ?? card?.xsecToken),
    author: user.nickname ?? user.nickName ?? null,
    author_id: user.userId ?? null,
    // 小红书给不了可靠的发布时间就如实缺省（time_estimated 由 normalize 按缺省置 1）
    published_at: Number.isFinite(timeMs) && timeMs > 0 ? timeMs : null,
    fetched_at: now(),
    thumb: cover,
    // video 笔记 kind 归 video（有 duration 时 normalize 也认）；图文归 note——M1 预留的形态位
    note_type: type === 'video' ? 'video' : 'image',
    duration_sec: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : null,
    stats: {
      likes: parseCount(interact.likedCount),
      collects: parseCount(interact.collectedCount),
      comments: parseCount(interact.commentCount)
    },
    // 正文：详情拿得到就是 full；detail 被跳过时 card 只有标题 → summary 由 normalize 判
    body_html: desc ? `<p>${desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '</p><p>')}</p>` : '',
    summary_html: desc ? `<p>${desc.slice(0, 200)}</p>` : (noteCard.displayTitle ? `<p>${noteCard.displayTitle}</p>` : ''),
    tags: Array.isArray(note?.tagList) ? note.tagList.map((t) => t.name).filter(Boolean) : []
  }
}

export const xhsAdapter = { type, fetch: fetchXhs }
