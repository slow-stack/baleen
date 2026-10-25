import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../paths.js'
import { createWbiSigner, BILI_HEADERS } from './bili-wbi.js'

const VERSION = '0.1.0'
export const type = 'bili'

/**
 * bili 适配器 —— B 站 UP 主视频列表 + 字幕，纯 fetch 直连 api.bilibili.com。
 *
 * 路线（2026-10-25 用户纠偏，M4a Task 2b）：MCP 子进程方案废弃，参照本机已跑通的
 * dsh-bili-scroll（coverFor 在用匿名 view 端点，index.js:2158）改直连：
 *  - 列表 x/space/wbi/arc/search —— wbi 签名（lib/adapters/bili-wbi.js，自研零依赖）；
 *  - 详情 x/web-interface/view —— 匿名可调（标题/简介/时长/封面/cid）；
 *  - 字幕 x/player/wbi/v2 —— 带 Cookie 才给 AI 字幕列表；cookie 由此降为"字幕增强"可选项，
 *    凭据文件不存在照样跑（该条按无字幕处理，预筛会丢），不再 credentials_missing 拦截。
 *
 * 边界（AGENTS.md 适配器红线）：
 *  - 只读：view / arc search / player info 全是查询端点，工具面零写操作；
 *  - 不判断、不写库：产出 RawItem，增量判定交给 putDraft 去重、backlog 交给 gate；
 *  - 零重试：本层从不重试，失败上抛交 pool 分类（412 风控整源失败、游标不推进）。
 */

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const ARC_SEARCH_URL = 'https://api.bilibili.com/x/space/wbi/arc/search'
const PLAYER_URL = 'https://api.bilibili.com/x/player/wbi/v2'
/** 一页 30 条（与旧 vendor 版对齐），足够一轮增量。 */
const LIST_PAGE_SIZE = 30
/** 字幕链路单请求预算（真机 run 18：字幕 CDN 慢是单条 30-60s 的主因，5s 拿不到就按无字幕走）。 */
const SUBTITLE_TIMEOUT_MS = 5000
/** detail 层并发上限（run 18：串行逐条把慢 CDN 放大成单条 30-60s；并发 3 是对 B 站风控的礼貌）。 */
const DETAIL_CONCURRENCY = 3
/**
 * 每轮新条目上限（M4b Task 3，与 yt 同款）：跳过已知后仍超量就只取列表序前 12 条（=最新优先），
 * 其余留给下一轮——这是预算分批不是丢：游标推进到窗口尾，下轮 knownIds 已含本轮 12 条，自然续传。
 */
const MAX_NEW_PER_RUN = 12

/**
 * arc/search 的风控指纹参数。该端点对"只有 wbi 签名的裸请求"回 412/HTML，社区公开资料的
 * 已知解法就是补一组 dm_img_* 值（B 站只验存在与形态，不验真伪）。本机 2026-10-25 匿名实测：
 * 纯 wbi → 412；补齐这组 → 200 code=0（固定伪串即可，无需 cookie；带 buvid3 反而 -352）。
 */
export const DM_FINGERPRINT = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMy4wIENocm9tZSkgJiZlbmNvZGVk',
  dm_cover_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMy4wIENocm9tZSkgJiZlbmNvZGVk',
  dm_img_inter: '{"ds":[],"wh":[3838,1871,1920,1080],"of":[318,1871,318]}'
}

/** 风控的两种形态：HTTP 层 412/429，业务码 -352。都算全局 circuit，整源失败。 */
const RISK_STATUSES = new Set([412, 429, -352])
const isRisk = e => RISK_STATUSES.has(e?.status)

// ── 小工具 ────────────────────────────────────────────────────────────────

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}

function truncate(s, n = 200) {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) : str
}

/** 解析 space.bilibili.com/<uid> 里的数字段；解析不出返回 null（源级 bad_source）。 */
export function parseSpaceUid(url) {
  const m = /space\.bilibili\.com\/(\d{1,20})/i.exec(String(url ?? ''))
  return m ? m[1] : null
}

/** "MM:SS" / "HH:MM:SS" → 秒；解析不出 null（detail.duration 才是正路，这只是列表兜底）。 */
export function parseLength(s) {
  const parts = String(s ?? '').trim().split(':').map(x => Number.parseInt(x, 10))
  if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return null
  const sec = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts.length === 2 ? parts[0] * 60 + parts[1] : null
  return sec > 0 ? sec : null
}

function intOrNull(v) {
  return Number.isFinite(v) ? Math.round(v) : null
}
function intMs(sec) {
  const n = intOrNull(sec)
  return n != null && n > 0 ? n * 1000 : null
}

/**
 * 受限并发映射，结果严格保持输入序（runner 按序对账每个源的抓取量，与 pool.runJobs 同一铁律）。
 * worker 模式与 lib/pool.js 同源但内联，不为它引池。任一元素抛错即 broken 置位：
 * 在飞的收完就停，不再发起新任务（风控/abort 时不给上游加压），异常原样上抛交 pool 分类。
 */
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, () => worker()))
  return results
}

/**
 * 凭据（字幕增强，可选）：credentials/bili-cookie.txt 是纯 Cookie 头文本，存在就整份带上。
 * 缺失返回 null——不拦截不报错；错误路径绝不返回文件内容，只说文件名（脱敏红线）。
 */
export function readCookieFile() {
  try {
    const text = fs.readFileSync(path.join(homeDir(), 'credentials', 'bili-cookie.txt'), 'utf8').trim()
    return text || null
  } catch { return null }
}

// ── API 调用与错误映射 ────────────────────────────────────────────────────

/**
 * 业务码错误的映射（与 pool 的分类对齐）：
 *  - 412 / 429（HTTP）与 -352（业务码）= 风控 → status 原值，整源失败游标不推进（spec §6.2）；
 *  - -101 = 账号未登录 → cookie 过期/无效的典型形态，钉 credentials 让面板一眼看出来；
 *  - 其余（-404 死视频等）带业务码上抛，调用方决定降级还是整源失败。
 */
function apiError(name, body, httpStatus) {
  const code = body?.code
  const msg = truncate(body?.message ?? '', 120)
  if (code === 412 || code === 429 || code === -352 || httpStatus === 412 || httpStatus === 429) {
    const st = httpStatus === 412 || httpStatus === 429 ? httpStatus : code
    return fail(`B 站风控 ${st}（${name}）：${msg || '请求被风控拦截'}`, { status: st, bili: body })
  }
  if (code === -101) {
    return fail(`B 站凭据被拒（code=-101 账号未登录，cookie 可能过期）：${msg}`, { status: -101, error_class: 'credentials', bili: body })
  }
  return fail(`B 站 ${name} 失败 code=${code ?? '?'}：${msg}`, { status: Number.isFinite(code) ? code : (httpStatus ?? 0), bili: body })
}

/**
 * api.bilibili.com 的 GET：非 2xx / 业务码非 0 都抛带 status 的错。
 * cookie 在场就带上（纯 Cookie 头文本原样），nav 的匿名场景由 wbi 模块自己处理。
 * signal（可选）：pool 超时即 abort 的取消链路——透传给 fetch，超时后在飞的请求立刻断。
 */
async function apiGet(name, url, { fetchImpl, cookie, signal }) {
  let res
  try {
    res = await fetchImpl(url, { headers: cookie ? { ...BILI_HEADERS, Cookie: cookie } : { ...BILI_HEADERS }, signal })
  } catch (e) {
    throw e // TypeError('fetch failed') 等原样上抛，pool 按 network 分类
  }
  if (!res?.ok) {
    const st = res?.status ?? 0
    throw fail(`B 站 ${name} HTTP ${st}`, {
      status: st,
      ...(st === 412 || st === 429 ? { bili: { code: st, reason: 'risk_control' } } : {})
    })
  }
  let body
  try { body = await res.json() } catch { throw fail(`B 站 ${name} 响应不是 JSON`, { parse: true }) }
  if (body?.code !== 0) throw apiError(name, body, res.status)
  return body
}

// ── 字幕（可选增强） ──────────────────────────────────────────────────────

/** AI/中文字幕优先，没有就第一条；空列表 null。 */
function pickSubtitle(subtitles) {
  if (!Array.isArray(subtitles) || !subtitles.length) return null
  return subtitles.find(s => /^(ai-|zh)/i.test(String(s?.lan ?? ''))) ?? subtitles[0]
}

/**
 * 字幕链路单请求的合并信号：外层取消（pool 90s 预算 abort）与 5s 预算竞速（node 24 原生
 * AbortSignal.any/timeout，零依赖）——外层 abort 立刻断（孤儿调用语义不变），否则单请求
 * 最多等 5s，超时按"没拿到字幕"降级，不再陪慢 CDN 干等。
 */
function subRequestSignal(outer) {
  const budget = AbortSignal.timeout(SUBTITLE_TIMEOUT_MS)
  return outer ? AbortSignal.any([outer, budget]) : budget
}

/**
 * 单条字幕全文：player/wbi/v2（签名）→ subtitle_url（json body[].content）→ 按 '\n' 拼。
 * 是否调 player 由调用方决定（源抓取路径 cookie 不在场就不调；现取路径匿名也试，CC 字幕
 * 匿名可能拿得到）。cookie 在场就带 Cookie 头。player 与字幕 json 两个请求都带 5s 预算
 * （真机 run 18：aisubtitle CDN 慢是单条 30-60s 的主因）。
 * 字幕是增强，网络/业务错误降级 null 只留诊断；唯独 412/429 风控要穿透——那是全局 circuit。
 */
async function fetchSubtitleText(ctx, bvid, cid) {
  if (cid == null) return null
  const headers = ctx.cookie ? { ...BILI_HEADERS, Cookie: ctx.cookie } : { ...BILI_HEADERS }
  try {
    const signed = await ctx.wbi.sign({ bvid, cid })
    const player = await apiGet('player 字幕', `${PLAYER_URL}?${new URLSearchParams(signed)}`, { ...ctx, cookie: ctx.cookie, signal: subRequestSignal(ctx.signal) })
    const sub = pickSubtitle(player?.data?.subtitle?.subtitles)
    const subUrl = String(sub?.subtitle_url ?? '').trim()
    if (!subUrl) return null
    const url = subUrl.startsWith('//') ? `https:${subUrl}` : subUrl
    const res = await ctx.fetchImpl(url, { headers, signal: subRequestSignal(ctx.signal) })
    if (!res?.ok) throw fail(`字幕文件 HTTP ${res?.status ?? '?'}`, { status: res?.status ?? 0 })
    let json
    try { json = await res.json() } catch { throw fail('字幕文件响应不是 JSON', { parse: true }) }
    const lines = (Array.isArray(json?.body) ? json.body : [])
      .map(l => String(l?.content ?? ''))
      .filter(Boolean)
    return lines.join('\n').trim() || null
  } catch (e) {
    if (isRisk(e)) throw e
    // pool 超时 abort：整单已死，字幕增强跟着断——原样上抛让上层停止，别再发起新请求（孤儿调用）。
    if (ctx.signal?.aborted) throw e
    // 5s 预算到点：CDN 慢就按无字幕处理（下一轮该视频照常走增量判断），一行慢诊断，不刷屏。
    if (e?.name === 'TimeoutError') {
      ctx.log('bili_subtitle_slow', `${bvid}：字幕请求超过 ${SUBTITLE_TIMEOUT_MS}ms，按无字幕处理`)
      return null
    }
    if (e.status === -101) {
      ctx.log('bili_subtitle_need_login', `${bvid}：凭据被拒（-101 账号未登录），按无字幕处理`)
      return null
    }
    ctx.log('bili_subtitle_failed', `${bvid}：${truncate(e.message, 120)}`)
    return null
  }
}

// ── RawItem 翻译 ──────────────────────────────────────────────────────────

/**
 * 列表一条 + detail 一条 → RawItem。
 * 字幕语义（M4a 修正版）：字幕全文非空 → subtitle_text + body=简介+\n\n+字幕（body_state=subtitle）；
 * cookie 缺席或字幕拿不到但**简介非空** → body=简介（body_state=summary_only，进候选）——匿名模式是常态，
 * B 站视频不能因为没配 cookie 就全部被预筛丢掉（与 RSS 摘要条目同待遇）；简介与字幕都空才是
 * missing（预筛按"无语音丢弃"）。burned_in 由预筛/判断侧承接，这里不判。
 */
async function toItem(ctx, source, v) {
  const bvid = String(v?.bvid ?? '').trim()
  const desc = String(v?.description ?? '').trim()

  let detail = null
  try {
    // 成本注记：每条增量视频一次 view（一轮 ≤30 条，增量通常个位数），压力上限由
    // fetchBili 的 detail 并发 3 兜住（mapLimit），本函数不感知并发。
    const res = await apiGet('视频详情', `${VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, ctx)
    detail = res?.data ?? null
  } catch (e) {
    // 风控/全局 circuit → 整源失败；其余（如视频已删除 -404）→ 该条降级 missing，别让一条死视频拖垮整个源。
    if (isRisk(e)) throw e
    // pool 超时 abort：整单已死，原样上抛让逐条循环立即断掉——别再打后续 detail（孤儿调用），
    // 也别把 abort 当"单条失败"记成 30 条假诊断。
    if (ctx.signal?.aborted) throw e
    ctx.log('bili_detail_failed', `${bvid}：${truncate(e.message, 120)}`)
  }

  const cid = intOrNull(detail?.cid)
  // 字幕增强：cookie 在场才打 player 请求；匿名模式跳过（打了也拿不到，白付一发）。
  const subtitleText = ctx.cookie ? await fetchSubtitleText(ctx, bvid, cid) : null

  const body = subtitleText ? (desc ? `${desc}\n\n${subtitleText}` : subtitleText) : desc
  const raw = {
    source_id: source.id,
    source_type: type,
    external_id: bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    title: String(v?.title ?? '').trim(),
    author: v?.author ?? detail?.owner?.name ?? null,
    published_at: intMs(v?.pubdate) ?? intMs(v?.created) ?? intMs(detail?.ctime),
    thumb: v?.pic ?? detail?.pic ?? null,
    duration_sec: intOrNull(detail?.duration) ?? parseLength(v?.length),
    body_html: body || null,
    tags: null,
    locale: null,
    fetched_at: ctx.stamped
  }
  if (subtitleText) raw.subtitle_text = subtitleText
  return raw
}

// ── fetch ─────────────────────────────────────────────────────────────────

/**
 * 一次源抓取：nav（wbi key）→ arc/search 列表（签名）→ 受限并发 3 的逐条 view + 可选字幕
 * （结果保持列表序；run 18：串行把慢字幕 CDN 放大成单条 30-60s，90s 预算只够 2-3 条）。
 * `since` 有意不用于过滤（对照 rss.js）：首轮 backlog 由 gate 管，这里全量返回列表页；
 * 增量判定有两道防线——先按 runner 注入的 knownIds 跳过已入库条目（M4b Task 3：
 * flat 列表每轮都是最新 30 条，不跳就是对全部条目重跑 detail+字幕，纯浪费且是 -352
 * 风控放大器），跳不干净（knownIds 截窗/直调未注入）再由 putDraft 按 external_id
 * =bvid 去重兜底；跳过后仍超 MAX_NEW_PER_RUN 就只取最新 12 条，其余留待下轮。
 * `knownIds`（可选）：该源已入库 external_id 的 Set，只读消费不碰库；全部条目已知时
 * 返回空数组（成功无新增，不是 empty 失败——增量抓取的稳态）。
 * `signal`（可选）：pool 超时即 abort 的取消链路，全链（nav/列表/逐条 detail/字幕）透传；
 * abort 后未完成的请求被 fetch 掐断、未发起的不再发起，已完成的部分结果由 pool 的 race 丢弃。
 */
export async function fetchBili(source, {
  since = null, // 保留形参对齐适配器接口；见上，不参与过滤
  signal,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  pref = null, // 保留形参对齐适配器接口；子进程路线废弃后暂无 bili 专用偏好键
  knownIds = null, // runner 注入：该源已入库 external_id 集合（跳过重抓）；直调不传=当全新
  log = () => {}
} = {}) {
  if (!source?.url) throw fail('bili 源缺少 url', { error_class: 'bad_source' })
  const uid = parseSpaceUid(source.url)
  if (!uid) throw fail('bili 源 url 解析不出 UID（要形如 https://space.bilibili.com/<uid>）', { error_class: 'bad_source' })

  const cookie = readCookieFile()
  if (!cookie) {
    // 字幕增强未启用：整轮留一行，不逐条刷屏
    log('bili_subtitle_need_login', '字幕增强未启用（credentials/bili-cookie.txt 不存在），视频按无字幕抓取')
  }
  const ctx = {
    fetchImpl,
    cookie,
    signal,
    wbi: createWbiSigner({ fetchImpl, now, signal }),
    stamped: now(),
    log
  }

  const signed = await ctx.wbi.sign({ mid: uid, ps: LIST_PAGE_SIZE, pn: 1, order: 'pubdate', ...DM_FINGERPRINT })
  const list = await apiGet('视频列表', `${ARC_SEARCH_URL}?${new URLSearchParams(signed)}`, ctx)
  const videos = list?.data?.list?.vlist
  if (!Array.isArray(videos)) throw fail('bili 视频列表响应缺 data.list.vlist 数组', { parse: true })
  if (!videos.length) throw fail(`bili 视频列表为空（uid=${uid}）——该 UP 没有视频，或 UID 抄错了（可对着 space 页核对）`, { empty: true })

  // 已入库跳过 + 每轮上限（M4b Task 3）：跳过是纯内存过滤，发生在任何 detail/字幕请求之前。
  // 全部已知 → fresh 为空 → 返回空数组（成功无新增）；列表本身为空的 empty 检查在上面，
  // 那是源级故障，与"这轮没有新视频"是两回事。
  let fresh = videos
  if (knownIds?.size) {
    const before = fresh.length
    fresh = fresh.filter(v => !knownIds.has(String(v?.bvid ?? '').trim()))
    if (fresh.length < before) log('bili_skipped_known', `${before - fresh.length} 条已入库，跳过详情与字幕`)
  }
  if (fresh.length > MAX_NEW_PER_RUN) {
    const deferred = fresh.length - MAX_NEW_PER_RUN
    fresh = fresh.slice(0, MAX_NEW_PER_RUN)
    log('bili_deferred', `本轮只处理 ${MAX_NEW_PER_RUN} 条新视频，${deferred} 条留待下轮`)
  }

  // detail 受限并发 3、保持顺序（run 18 调优）：外层 signal 仍全链透传——abort 时在飞的
  // 子请求全断、mapLimit 不再发起新的；字幕请求另带 5s 预算（与外层 signal any 合并）。
  const mapped = await mapLimit(fresh, DETAIL_CONCURRENCY, async (v) => {
    if (!String(v?.bvid ?? '').trim()) {
      log('bili_item_skipped', '列表项缺 bvid，跳过')
      return null
    }
    return toItem(ctx, source, v)
  })
  return mapped.filter(Boolean)
}

/**
 * 现取单条视频的字幕全文（baleen.subtitle 工具的后端，M4a Task 3）：
 * view 拿 cid → player/wbi/v2（签名）→ 字幕 json 拼全文。无 cookie 也匿名跑（CC 字幕
 * 匿名可能拿得到），cookie 在场才带 Cookie 头。player 与字幕 json 带 5s 预算（慢 CDN
 * 超时按没取到处理）。
 * 返回空串 = 这次没取到字幕（含匿名无字幕、列表为空、凭据被拒，各留诊断），no_subtitle 由调用方裁定；
 * 412 原样上浮，bad_source（bvid 空）在零请求时抛出。
 */
export async function fetchBiliSubtitle(bvid, {
  fetchImpl = globalThis.fetch,
  signal, // 工具路径暂无超时信号，留全链一致的取消口子
  pref = null, // 保留形参对齐旧签名；无实际消费
  log = () => {},
  now = Date.now
} = {}) {
  const id = String(bvid ?? '').trim()
  if (!id) throw fail('bili 现取字幕缺少 bvid', { error_class: 'bad_source' })
  const cookie = readCookieFile()
  if (!cookie) {
    log('bili_subtitle_need_login', `${id}：字幕增强未启用（credentials/bili-cookie.txt 不存在），先试匿名（AI 字幕多半取不到）`)
  }
  const ctx = { fetchImpl, cookie, signal, wbi: createWbiSigner({ fetchImpl, now, signal }), stamped: now(), log }
  const res = await apiGet('视频详情', `${VIEW_URL}?bvid=${encodeURIComponent(id)}`, ctx)
  const cid = intOrNull(res?.data?.cid)
  if (cid == null) return ''
  return (await fetchSubtitleText(ctx, id, cid)) ?? ''
}

export const biliAdapter = { type, fetch: fetchBili }
