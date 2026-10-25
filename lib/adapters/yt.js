import { spawn } from 'node:child_process'
import { parseJson3, parseVtt } from './yt-captions.js'

export const type = 'yt'

/**
 * yt 适配器 —— YouTube 频道/播放列表/单视频，经 yt-dlp 子进程直连（M4b Task 1）。
 *
 * 路线（计划 2026-10-25-baleen-m4b-yt，命令形态来自本机实测）：
 *  - 列表 `yt-dlp --dump-single-json --flat-playlist --playlist-items 30 <url>` → entries[]（id/title）；
 *  - 单视频 `--dump-single-json <watch_url>` → duration/upload_date/description/thumbnail/
 *    subtitles（manual）/automatic_captions（auto，每轨 url+ext=json3|vtt）；
 *  - 字幕轨 URL 直接 fetch（json3 是 YouTube API 形态，匿名可用）。
 *
 * 结构照抄 bili（M4a Task 2b/2c/2d 的调优成果）：dump 并发 3 保序（mapLimit）、
 * 字幕 5s 预算（AbortSignal.any）、abort 全链（子进程 kill + fetch 掐断）、
 * 诊断日志 yt_xxx 同款命名。
 *
 * 边界（AGENTS.md 适配器红线）：
 *  - 只读：yt-dlp 的 dump 系参数 + 字幕轨 GET，零平台写操作；
 *  - 不判断、不写库：产出 RawItem，增量判定交给 putDraft、backlog 交给 gate；
 *  - 零重试：本层从不重试，失败上抛交 pool 分类（失败不推进游标）。
 */

/** 一轮 flat 列表条数（与实测命令一致，足够一轮增量）。 */
const LIST_LIMIT = 30
/** 字幕轨单请求预算：5s 拿不到就按无字幕走（照抄 bili 的慢 CDN 教训）。 */
const SUBTITLE_TIMEOUT_MS = 5000
/** 单视频 dump 并发上限（照抄 bili 的 detail 并发 3：礼貌 + 保序下的吞吐）。 */
const DETAIL_CONCURRENCY = 3
/** 子进程硬超时：防 yt-dlp 挂死把 90s 的 job 预算整个吃掉（kill 后按 timeout 上抛）。 */
const CHILD_TIMEOUT_MS = 60000

// ── 小工具 ────────────────────────────────────────────────────────────────

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}

function truncate(s, n = 200) {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) : str
}

function intOrNull(v) {
  return Number.isFinite(v) ? Math.round(v) : null
}

/** upload_date "YYYYMMDD" → UTC 毫秒；形态坏或月日越界（Date.UTC 会进位）返回 null。 */
export function uploadDateMs(v) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const dt = new Date(ms)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ms : null
}

/**
 * 从源 url 里认出"单视频"形态（youtube.com/watch?v=<id> 或 youtu.be/<id>）。
 * 真机实测（2026-10-26 冒烟）：--flat-playlist 打在 watch URL 上回的是视频自身 JSON
 * （没有 entries）——单视频源必须走独立的单次 dump 路线，不能混进 flat 列表路线。
 */
export function parseVideoId(url) {
  const s = String(url ?? '')
  return /youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{6,})/.exec(s)?.[1]
    ?? /youtu\.be\/([A-Za-z0-9_-]{6,})/.exec(s)?.[1]
    ?? null
}

function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
}

/**
 * 受限并发映射，结果严格保持输入序（runner 按序对账，与 pool.runJobs 同一铁律）。
 * 与 bili.js 同源的 worker 模式：任一元素抛错即 broken 置位，在飞的收完就停、
 * 不再发起新任务（abort 时不给上游加压），异常原样上抛交 pool 分类。
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

// ── yt-dlp 子进程 ─────────────────────────────────────────────────────────

/** spawn 失败（ENOENT＝二进制不存在）→ unavailable（spec §6.2 缺依赖）。 */
function spawnFail(e) {
  return fail(`yt-dlp 不可用（${e?.code ?? 'spawn error'}）：装好 yt-dlp 并放进 PATH，或在 preference.yaml 顶层设 yt_dlp_path`, { error_class: 'unavailable' })
}

/** 非零退出时取的输出尾行：stderr 优先（ERROR: 行在这里），取最后一条非空行，截断 120。 */
function outputTail(errOut, out) {
  const lines = String(errOut || out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return truncate(lines[lines.length - 1] ?? '', 120)
}

/**
 * 一次 yt-dlp 调用（缺省 child_process.spawn；测试注入 spawnImpl）。
 * stdout 自己拼接（无 maxBuffer 上限烦恼）；abort 全链：外层 signal 一 abort 就
 * child.kill()，exit 到来时按取消上抛；CHILD_TIMEOUT_MS 硬超时同样 kill。
 * 退出 0 但 stdout 空 / JSON 形态坏都按 parse 上抛——绝不把空输出当成功（游标红线）。
 */
function runYtDlp(ctx, baseArgs, url, timeoutMs = ctx.childTimeoutMs ?? CHILD_TIMEOUT_MS) {
  const args = [...baseArgs, ...(ctx.proxy ? ['--proxy', ctx.proxy] : []), url]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = ctx.spawnImpl(ctx.ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(spawnFail(e))
      return
    }
    if (ctx.signal?.aborted) {
      try { child.kill() } catch {}
      reject(abortError())
      return
    }
    let out = ''
    let errOut = ''
    let settled = false
    let timer = null
    const settle = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
      fn(v)
    }
    const onAbort = () => { try { child.kill() } catch {} }
    child.stdout?.on('data', c => { out += String(c) })
    child.stderr?.on('data', c => { errOut += String(c) })
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      try { child.kill() } catch {}
      const e = fail(`yt-dlp 子进程 ${timeoutMs}ms 未退出，已终止（防挂死）`, { timeout: true })
      e.name = 'TimeoutError'
      settle(reject, e)
    }, timeoutMs)
    child.on?.('error', e => settle(reject, spawnFail(e)))
    child.on?.('exit', code => {
      if (ctx.signal?.aborted) return settle(reject, abortError())
      if (code === 0) {
        if (!out.trim()) return settle(reject, fail('yt-dlp 退出 0 但 stdout 为空', { parse: true }))
        return settle(resolve, out)
      }
      settle(reject, fail(`yt-dlp 退出码 ${code ?? '?'}：${outputTail(errOut, out)}`, { parse: true }))
    })
  })
}

function abortError() {
  return Object.assign(new Error('yt-dlp 子进程被取消'), { name: 'AbortError' })
}

// ── 字幕轨 ────────────────────────────────────────────────────────────────

/**
 * 挑字幕轨（计划 Task 1 的优先级）：manual zh-Hans/zh-Hant/zh > manual en > auto zh > auto en；
 * 语言桶内 json3 优先（结构化、无标签），vtt 兜底（极简解析器接得住）。
 * langs 是前缀匹配：zh 覆盖 zh-Hans/zh-Hant/zh-CN/zh-TW，en 覆盖 en-US/en-GB。
 */
function trackForLangs(group, prefix) {
  if (!group || typeof group !== 'object') return null
  for (const [lang, tracks] of Object.entries(group)) {
    if (!Array.isArray(tracks)) continue
    if (!String(lang).toLowerCase().startsWith(prefix)) continue
    const track = tracks.find(t => t?.ext === 'json3' && t?.url) ?? tracks.find(t => t?.ext === 'vtt' && t?.url)
    if (track) return { ...track, lang }
  }
  return null
}

export function pickCaptionTrack(detail) {
  return trackForLangs(detail?.subtitles, 'zh')
    ?? trackForLangs(detail?.subtitles, 'en')
    ?? trackForLangs(detail?.automatic_captions, 'zh')
    ?? trackForLangs(detail?.automatic_captions, 'en')
}

/** 字幕轨单请求的合并信号：外层取消与 5s 预算竞速（照抄 bili 的 subRequestSignal）。 */
function subRequestSignal(outer) {
  const budget = AbortSignal.timeout(SUBTITLE_TIMEOUT_MS)
  return outer ? AbortSignal.any([outer, budget]) : budget
}

/**
 * 单条字幕全文：轨 URL fetch → 按 ext 走 parseJson3 / parseVtt。
 * 字幕是增强：失败/超时降级 null 只留一行诊断；唯独外层 abort 要穿透上抛
 * （整单已死，别再发起新请求）。
 */
async function fetchCaptionText(ctx, id, track) {
  try {
    const res = await ctx.fetchImpl(track.url, { signal: subRequestSignal(ctx.signal) })
    if (!res?.ok) throw fail(`字幕轨 HTTP ${res?.status ?? '?'}`, { status: res?.status ?? 0 })
    const text = await res.text()
    const parsed = track.ext === 'json3' ? parseJson3(text) : parseVtt(text)
    return parsed.trim() || null
  } catch (e) {
    if (ctx.signal?.aborted) throw e
    if (e?.name === 'TimeoutError') {
      ctx.log('yt_subtitle_slow', `${id}：字幕请求超过 ${SUBTITLE_TIMEOUT_MS}ms，按无字幕处理`)
      return null
    }
    ctx.log('yt_subtitle_failed', `${id}：${truncate(e.message, 120)}`)
    return null
  }
}

// ── RawItem 翻译 ──────────────────────────────────────────────────────────

/**
 * 单视频 dump 详情 → RawItem（字幕选取与三态语义都在这）。
 * body_state 语义（照计划逐字）：拿到任何字幕轨文本 = subtitle_text + body=简介+\n\n+字幕
 * （auto captions 虽是平台 ASR，形态就是字幕轨，与 bili 的 AI 字幕同待遇）；
 * 无字幕但简介非空 = body=简介（summary_only，进候选）；都空 = body 缺席（missing，
 * 预筛按无语音丢弃）。burned_in 由预筛/判断侧承接，这里不判。
 */
async function buildRaw(ctx, source, id, d, listTitle = '') {
  const desc = String(d?.description ?? '').trim()
  const track = pickCaptionTrack(d)
  const subtitleText = track ? await fetchCaptionText(ctx, id, track) : null
  const body = subtitleText ? (desc ? `${desc}\n\n${subtitleText}` : subtitleText) : desc

  const raw = {
    source_id: source.id,
    source_type: type,
    external_id: id,
    url: watchUrl(id),
    title: String(d?.title ?? listTitle ?? '').trim(),
    author: d?.uploader ?? d?.channel ?? null,
    published_at: uploadDateMs(d?.upload_date),
    thumb: d?.thumbnail ?? null,
    duration_sec: intOrNull(d?.duration),
    body_html: body || null,
    tags: null,
    locale: null,
    fetched_at: ctx.stamped
  }
  if (subtitleText) raw.subtitle_text = subtitleText
  return raw
}

/**
 * flat 列表一条 + 单视频 dump → RawItem。
 * 单条 dump 失败（私享/删档）降级：列表 title 兜底、其余字段缺省 → missing，
 * 一条死视频不能拖垮整源（同 bili 的 -404 裁定）；unavailable / abort / 硬超时穿透。
 */
async function toItem(ctx, source, id, listTitle) {
  let d = null
  try {
    const out = await runYtDlp(ctx, ['--dump-single-json'], watchUrl(id))
    d = JSON.parse(out)
    if (!d || typeof d !== 'object') throw fail('单视频 dump 不是 JSON 对象', { parse: true })
  } catch (e) {
    if (e?.error_class === 'unavailable' || e?.name === 'TimeoutError' || e?.name === 'AbortError' || ctx.signal?.aborted) throw e
    ctx.log('yt_detail_failed', `${id}：${truncate(e.message, 120)}`)
  }
  return buildRaw(ctx, source, id, d, listTitle)
}

// ── fetch ─────────────────────────────────────────────────────────────────

/**
 * 一次源抓取。两条路线：
 *  - 列表源（频道 /videos、playlist）：flat-playlist（30 条）→ 受限并发 3 的逐视频
 *    dump + 可选字幕（保持列表序）；
 *  - 单视频源（watch?v= / youtu.be）：直接一次 dump-single-json——真机实测 flat 打在
 *    watch URL 上回的是视频自身 JSON（无 entries），必须分流。
 * `since` 有意不用于过滤（对照 rss/bili）：flat 条目没有时间戳，增量判定由 putDraft
 * 按 external_id=视频 id 去重完成，首轮 backlog 由 gate 管。
 * `signal`（可选）：pool 超时即 abort 的取消链路——子进程被 kill、字幕 fetch 被掐断、
 * 未发起的不再发起，已完成的部分结果由 pool 的 race 丢弃。
 * `pref`：yt_dlp_path（缺省 'yt-dlp' 走 PATH）、network.proxy（缺省空；设置后只给
 * yt-dlp 加 --proxy 参数，不改全局 fetch——宿主无代理环境的逃生门）。
 */
export async function fetchYt(source, {
  since = null, // 保留形参对齐适配器接口；见上，不参与过滤
  signal,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  pref = null,
  log = () => {},
  childTimeoutMs // 测试注入口（硬超时桩），调用方不设走 CHILD_TIMEOUT_MS
} = {}) {
  if (!source?.url || !/^https?:\/\//i.test(String(source.url))) {
    throw fail('yt 源缺少 url（要 http(s) 的频道 /videos、playlist 或单视频 URL）', { error_class: 'bad_source' })
  }
  const ctx = {
    fetchImpl,
    spawnImpl,
    signal,
    ytDlp: String(pref?.yt_dlp_path || 'yt-dlp'),
    proxy: String(pref?.network?.proxy || '').trim(),
    stamped: now(),
    log,
    childTimeoutMs
  }

  // 单视频源：没有列表可兜底，dump 失败就是整源失败（游标不推进），不产假 missing。
  const singleId = parseVideoId(source.url)
  if (singleId) {
    const out = await runYtDlp(ctx, ['--dump-single-json'], String(source.url))
    let d
    try { d = JSON.parse(out) } catch { throw fail('yt 单视频 dump 响应不是 JSON', { parse: true }) }
    if (!d || typeof d !== 'object') throw fail('yt 单视频 dump 不是 JSON 对象', { parse: true })
    const id = String(d?.id ?? '').trim() || singleId
    return [await buildRaw(ctx, source, id, d)]
  }

  const flatOut = await runYtDlp(ctx, ['--dump-single-json', '--flat-playlist', '--playlist-items', String(LIST_LIMIT)], String(source.url))
  let entries
  try {
    entries = JSON.parse(flatOut)?.entries
  } catch {
    throw fail('yt 频道列表响应不是 JSON', { parse: true })
  }
  if (!Array.isArray(entries)) throw fail('yt 列表响应缺 entries 数组', { parse: true })
  if (!entries.length) throw fail('yt 列表为空——该频道/播放列表没有条目，或 URL 抄错（要频道 /videos、playlist 或单视频 URL）', { empty: true })

  // dump 受限并发 3、保持列表序（照抄 bili 的 mapLimit）：abort 时在飞的子进程全 kill、
  // 未发起的不再发起；字幕请求另带 5s 预算（与外层 signal any 合并）。
  const mapped = await mapLimit(entries, DETAIL_CONCURRENCY, async (e) => {
    const id = String(e?.id ?? '').trim()
    if (!id) {
      log('yt_item_skipped', '列表项缺 id，跳过')
      return null
    }
    return toItem(ctx, source, id, String(e?.title ?? '').trim())
  })
  return mapped.filter(Boolean)
}

export const ytAdapter = { type, fetch: fetchYt }
