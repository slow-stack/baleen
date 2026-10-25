import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../paths.js'
import { parseJson3, parseVtt } from './yt-captions.js'

export const type = 'yt'

/**
 * yt 适配器 —— YouTube 频道/播放列表/单视频，经 yt-dlp 子进程直连（M4b Task 1，1b 修字幕路线）。
 *
 * 路线（计划 2026-10-25-baleen-m4b-yt + Task 1b 简报，命令形态来自本机实测）：
 *  - 列表 `yt-dlp --dump-single-json --flat-playlist --playlist-items 30 <url>` → entries[]（id/title）；
 *  - 单视频 `--dump-single-json <watch_url>` → duration/upload_date/description/thumbnail；
 *  - 字幕**同样走 yt-dlp**（Task 1b：不再 fetch 轨 URL——node fetch 不读系统代理，宿主内
 *    绕开了代理生态；yt-dlp 自己读系统代理/--proxy，一个网络行为者、一套代理故事）：
 *    `--skip-download --write-subs --write-auto-subs --ignore-errors --sub-langs <全语言表>
 *     --sub-format json3/vtt -o <home>/tmp/yt-subs/<id>/%(id)s.%(ext)s <watch_url>`，
 *    一次列全部优先级语言、下载后**按优先级挑第一个解析出非空文本的落盘文件**——
 *    某轨 429 时其余轨照样落盘（探针实锤：--ignore-errors 是前提，否则首轨 429 会中断
 *    全部字幕写入），轨间回退（zh 限流退 en）由此天然实现。读完即删目录。
 *    这是**选择回退不是重试**：每条视频只打一次字幕调用，同一轨绝不重打。
 *
 * 结构照抄 bili（M4a Task 2b/2c/2d 的调优成果）：dump 并发 3 保序（mapLimit）、
 * abort 全链（子进程 kill）、诊断日志 yt_xxx 同款命名。
 *
 * 边界（AGENTS.md 适配器红线）：
 *  - 只读：yt-dlp 的 dump/字幕系参数，零平台写操作；
 *  - 不判断、不写库：产出 RawItem，增量判定交给 putDraft、backlog 交给 gate；
 *  - 零重试：本层从不重试，失败上抛交 pool 分类（失败不推进游标）。
 */

/** 一轮 flat 列表条数（与实测命令一致，足够一轮增量）。 */
const LIST_LIMIT = 30
/** 单视频 dump 并发上限（照抄 bili 的 detail 并发 3：礼貌 + 保序下的吞吐）。 */
const DETAIL_CONCURRENCY = 3
/**
 * 子进程硬超时：防 yt-dlp 挂死把 90s 的 job 预算整个吃掉（kill 后按 timeout 上抛）。
 * Task 1b 起 30s——每条视频两次 spawn（dump + 字幕落盘），30s×2=60s 仍留在 90s 预算内。
 */
const CHILD_TIMEOUT_MS = 30000
/**
 * 字幕语言优先级（Task 1b 简报钦定，同时是 --sub-langs 参数与落盘文件的挑选顺序）：
 * zh-Hans > zh-Hant > zh > en-orig（原语言轨）> en。auto/manual 之分在文件层不可见，
 * 也不必可见——同一语言拿到的是平台给的最好那份。
 */
const SUB_LANGS = ['zh-Hans', 'zh-Hant', 'zh', 'en-orig', 'en']

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

/** 视频 id 会成为落盘目录名（Task 1b）：只放行 [A-Za-z0-9_-]，杜绝 ../ 之类脏路径。 */
function safeId(v) {
  const s = String(v ?? '').trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null
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

// ── 字幕（yt-dlp 落盘 + 按优先级挑文件；Task 1b） ─────────────────────────

/** 字幕落盘调用的参数（URL 由 runYtDlp 拼在最后）。 */
function subtitleArgs(dir) {
  return [
    '--skip-download',
    '--write-subs', '--write-auto-subs',
    // 探针实锤（2026-10-26）：某轨 429 时默认会中断全部字幕写入，en 一并丢掉；
    // --ignore-errors 让失败轨降级成 WARNING、其余轨照常落盘——轨间回退的前提。
    '--ignore-errors',
    '--sub-langs', SUB_LANGS.join(','),
    '--sub-format', 'json3/vtt',
    '-o', path.join(dir, '%(id)s.%(ext)s')
  ]
}

/**
 * 落盘文件按优先级挑选：SUB_LANGS 语言序 × json3→vtt 格式序，
 * 第一个存在且解析出非空文本的赢（429 的轨不落盘或落了残件，自然被跳过）。
 */
function pickSubtitleFile(dir, id) {
  for (const lang of SUB_LANGS) {
    for (const ext of ['json3', 'vtt']) {
      let raw
      try {
        raw = fs.readFileSync(path.join(dir, `${id}.${lang}.${ext}`), 'utf8')
      } catch {
        continue
      }
      const text = (ext === 'json3' ? parseJson3(raw) : parseVtt(raw)).trim()
      if (text) return { lang, ext, text }
    }
  }
  return null
}

/** 字幕诊断脱敏：yt-dlp 尾行可能带落盘绝对路径（-o 模板），日志里换成占位符（AGENTS 红线 7）。 */
function scrub(ctx, s) {
  let out = String(s ?? '')
  for (const p of [ctx.subsRoot, ctx.homeHint].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(p).join('<路径已隐去>')
  }
  return out
}

/**
 * 单条视频字幕全文：yt-dlp 落盘到 <home>/tmp/yt-subs/<id>/ → 按优先级挑文件解析 → 删目录。
 * M4b Task 2 起导出：fetchYt 的每视频流程与 baleen.subtitle 工具的现取共用这一条实现
 * （工具路径与抓取路径的行为、默认值由同一份代码钉死，不会各自漂移）。
 * 字幕是增强：字幕调用非零退出/没拿到可用文件 → 降级 null 只留一行诊断；
 * 唯独 abort / 硬超时 / 二进制缺失穿透上抛（调用方已死或缺依赖，别再发新调用）。
 * 每条视频恰好一次字幕调用——回退只发生在"挑哪个已落盘文件"，绝不重打同一轨。
 * pref 键与 fetchYt 同源：yt_dlp_path（缺省 'yt-dlp' 走 PATH）、network.proxy（缺省空）。
 */
export async function fetchYtSubtitle(videoId, {
  spawnImpl = spawn,
  pref = null,
  signal,
  log = () => {},
  childTimeoutMs, // 测试注入口（硬超时桩），调用方不设走 CHILD_TIMEOUT_MS
  subsRoot // 测试注入口：字幕落盘根目录，调用方不设走 <home>/tmp/yt-subs
} = {}) {
  const ctx = {
    spawnImpl,
    signal,
    ytDlp: String(pref?.yt_dlp_path || 'yt-dlp'),
    proxy: String(pref?.network?.proxy || '').trim(),
    log,
    childTimeoutMs,
    subsRoot: subsRoot ?? path.join(homeDir(), 'tmp', 'yt-subs'),
    homeHint: homeDir(),
  }
  const id = String(videoId ?? '')
  const dir = path.join(ctx.subsRoot, id)
  fs.rmSync(dir, { recursive: true, force: true }) // 清上一轮残留（失败也绝不留脏目录）
  fs.mkdirSync(dir, { recursive: true })
  let runError = null
  try {
    await runYtDlp(ctx, subtitleArgs(dir), watchUrl(id))
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.error_class === 'unavailable') {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      throw e
    }
    runError = e // 非零退出不等于没字幕（en 可能已落盘），扫完文件再定
  }
  let picked = null
  try {
    picked = pickSubtitleFile(dir, id)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} // 解析进内存即删
  }
  if (!picked) {
    if (runError) ctx.log('yt_subtitle_failed', `${id}：${scrub(ctx, truncate(runError.message, 120))}`)
    return null // 没轨不是失败：无字幕视频零诊断行
  }
  if (picked.lang !== SUB_LANGS[0]) {
    ctx.log('yt_subtitle_lang_fallback', `${id}：首选 ${SUB_LANGS[0]} 没拿到，回退用 ${picked.lang} 字幕`)
  }
  return picked.text
}

// ── RawItem 翻译 ──────────────────────────────────────────────────────────

/**
 * 单视频 dump 详情 → RawItem（字幕三态语义都在这）。
 * body_state 语义（照计划逐字）：拿到字幕文本 = subtitle_text + body=简介+\n\n+字幕
 * （auto captions 虽是平台 ASR，形态就是字幕轨，与 bili 的 AI 字幕同待遇）；
 * 无字幕但简介非空 = body=简介（summary_only，进候选）；都空 = body 缺席（missing，
 * 预筛按无语音丢弃）。burned_in 由预筛/判断侧承接，这里不判。
 * d 为 null（dump 失败的降级条目）时不发起字幕调用——连元数据都没有，照旧 missing。
 */
async function buildRaw(ctx, source, id, d, listTitle = '') {
  const desc = String(d?.description ?? '').trim()
  // 字幕现取走导出的 fetchYtSubtitle（与工具面同一实现）：fetchYt 的注入原样透传，
  // ytDlp/proxy 在其内部从同一份 pref 重导出——推导纯函数，值与本 ctx 恒等。
  const subtitleText = d ? await fetchYtSubtitle(id, {
    spawnImpl: ctx.spawnImpl,
    pref: ctx.pref,
    signal: ctx.signal,
    log: ctx.log,
    childTimeoutMs: ctx.childTimeoutMs,
    subsRoot: ctx.subsRoot,
  }) : null
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
 *    "dump + 字幕落盘"（每条两次 spawn，保持列表序）；
 *  - 单视频源（watch?v= / youtu.be）：直接一次 dump-single-json——真机实测 flat 打在
 *    watch URL 上回的是视频自身 JSON（无 entries），必须分流。
 * `since` 有意不用于过滤（对照 rss/bili）：flat 条目没有时间戳，增量判定由 putDraft
 * 按 external_id=视频 id 去重完成，首轮 backlog 由 gate 管。
 * `signal`（可选）：pool 超时即 abort 的取消链路——子进程被 kill、未发起的不再发起，
 * 已完成的部分结果由 pool 的 race 丢弃。
 * `pref`：yt_dlp_path（缺省 'yt-dlp' 走 PATH）、network.proxy（缺省空；设置后只给
 * yt-dlp 加 --proxy 参数——Task 1b 起字幕也走 yt-dlp，yt 源的全部网络都在这一条道上）。
 * `subsRoot`（测试注入）：字幕落盘根目录，缺省 <home>/tmp/yt-subs（paths.js 的 home 约定）。
 */
export async function fetchYt(source, {
  since = null, // 保留形参对齐适配器接口；见上，不参与过滤
  signal,
  now = Date.now,
  spawnImpl = spawn,
  pref = null,
  log = () => {},
  childTimeoutMs, // 测试注入口（硬超时桩），调用方不设走 CHILD_TIMEOUT_MS
  subsRoot // 测试注入口：字幕落盘根目录，调用方不设走 <home>/tmp/yt-subs
} = {}) {
  if (!source?.url || !/^https?:\/\//i.test(String(source.url))) {
    throw fail('yt 源缺少 url（要 http(s) 的频道 /videos、playlist 或单视频 URL）', { error_class: 'bad_source' })
  }
  const ctx = {
    spawnImpl,
    signal,
    ytDlp: String(pref?.yt_dlp_path || 'yt-dlp'),
    proxy: String(pref?.network?.proxy || '').trim(),
    stamped: now(),
    log,
    childTimeoutMs,
    subsRoot: subsRoot ?? path.join(homeDir(), 'tmp', 'yt-subs'),
    pref, // 原样留存：buildRaw 透传给 fetchYtSubtitle（其内部从 pref 重导出 ytDlp/proxy/subsRoot 默认）
  }

  // 单视频源：没有列表可兜底，dump 失败就是整源失败（游标不推进），不产假 missing。
  const singleId = parseVideoId(source.url)
  if (singleId) {
    const out = await runYtDlp(ctx, ['--dump-single-json'], String(source.url))
    let d
    try { d = JSON.parse(out) } catch { throw fail('yt 单视频 dump 响应不是 JSON', { parse: true }) }
    if (!d || typeof d !== 'object') throw fail('yt 单视频 dump 不是 JSON 对象', { parse: true })
    const id = safeId(d?.id) ?? singleId // dump 回的 id 形态异常时退回 URL 里那份
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
  // 未发起的不再发起；每条视频 dump → 字幕落盘串行，单飞峰值仍是 3 个子进程。
  const mapped = await mapLimit(entries, DETAIL_CONCURRENCY, async (e) => {
    const id = safeId(e?.id)
    if (!id) {
      log('yt_item_skipped', '列表项缺 id 或形态异常（要 [A-Za-z0-9_-]），跳过')
      return null
    }
    return toItem(ctx, source, id, String(e?.title ?? '').trim())
  })
  return mapped.filter(Boolean)
}

export const ytAdapter = { type, fetch: fetchYt }
