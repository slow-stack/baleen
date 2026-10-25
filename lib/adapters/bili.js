import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../paths.js'

const VERSION = '0.1.0'
export const type = 'bili'

/**
 * bili 适配器 —— B 站 UP 主视频列表 + 字幕，经 vendored BiliStalkerMCP 子进程。
 *
 * 边界（AGENTS.md 适配器红线）：
 *  - 只读：只调 get_user_videos / get_video_detail，工具面零写操作；
 *  - 不判断、不写库：产出 RawItem，增量判定交给 putDraft 去重、backlog 交给 gate；
 *  - 零重试：本层从不重试；vendor 内部重试已被补丁 B 压到 1 次，那 1 次就是全部预算。
 *
 * 帧格式（2026-10-25 用 conda 环境真起 serve 进程实测，非猜测）：
 *  fastmcp 的 stdio 是「一行一条 JSON-RPC」（无 Content-Length 头），
 *  ToolError 不走 JSON-RPC error，而是 result.isError=true + content[0].text；
 *  成功载荷在 result.structuredContent（服务端声明了 output_schema）。
 */

/** 单个子进程的生命周期上限：起进程 → 握手 → 列表 → 逐条 detail 全在这一程。 */
export const PROCESS_TIMEOUT_MS = 60000
/** kill() 之后等退出的余量，超过走 taskkill /T /F 兜底（Windows 不留孤儿）。 */
const REAP_GRACE_MS = 2000
/** vendor MAX_VIDEO_LIMIT=30，顶格取第一页。 */
const LIST_PAGE_SIZE = 30

// ── 小工具 ────────────────────────────────────────────────────────────────

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}
const netErr = message => fail(message, { error_class: 'network' })

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

/** vendor 输出 "YYYY-MM-DD HH:MM"（BILI_TIMEZONE，默认 Asia/Shanghai）。只做兜底：正路是 detail.ctime 毫秒。 */
function parseStamp(s) {
  const t = Date.parse(String(s ?? '').trim().replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}

/**
 * bili_python 解析：绝对路径直接用；否则当 conda 环境名，按 <root>/envs/<名>/python.exe 展开。
 * conda 根默认 D:\Miniconda（本机实测布局），可用 BALEEN_CONDA_ROOT 覆盖（测试/异机）。
 */
export function resolveBiliPython(pref) {
  let raw = String(pref?.bili_python ?? 'baleen-bili').trim() || 'baleen-bili'
  if (/[\\/]/.test(raw) || /\.(exe|bat|cmd)$/i.test(raw)) return raw
  const root = (process.env.BALEEN_CONDA_ROOT ?? 'D:\\Miniconda').trim() || 'D:\\Miniconda'
  return path.join(root, 'envs', raw, 'python.exe')
}

// ── stdio JSON-RPC 会话 ───────────────────────────────────────────────────

/**
 * 一个 serve 子进程。请求按序（适配器流程本来就是顺序的），响应按 id 配对；
 * 进程级故障（exit / error / 超时）让所有在途请求一起失败，error_class=network。
 */
function createSession({ spawnImpl, cmd, args, env, timeoutMs = PROCESS_TIMEOUT_MS }) {
  const child = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
  const pending = new Map()
  let nextId = 1
  let buf = ''
  let stderrTail = ''
  let dead = false
  let deadError = null
  let watchdog = null

  function die(e) {
    if (dead) return
    dead = true
    deadError = e
    try { child.kill() } catch { /* 已经退出 */ }
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }

  if (child.stdout?.on) {
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onFrame(line)
      }
    })
  }
  if (child.stderr?.on) {
    child.stderr.setEncoding?.('utf8')
    // vendor 日志走 stderr（JSON 格式，已脱敏）；只留最后一行做崩溃诊断，绝不入 RawItem。
    child.stderr.on('data', d => {
      const lines = String(d).split('\n').filter(l => l.trim())
      if (lines.length) stderrTail = truncate(lines[lines.length - 1], 160)
    })
  }
  child.on?.('exit', code => die(netErr(`bili 子进程提前退出（code=${code ?? '?'}）${stderrTail ? `：${stderrTail}` : ''}`)))
  child.on?.('error', e => die(netErr(`bili 子进程启动失败（检查 preference 的 bili_python）：${truncate(e?.code ?? e?.message, 80)}`)))

  function onFrame(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return } // 非 JSON 行不该有；见了就忽略
    if (msg?.id == null) return // notification（如 logging）没有 id，忽略
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) {
      p.reject(fail(`MCP 协议错误 ${msg.error.code ?? '?'}：${truncate(msg.error.message, 160)}`,
        { status: Number.isFinite(msg.error.code) ? msg.error.code : undefined }))
    } else {
      p.resolve(msg.result)
    }
  }

  watchdog = setTimeout(() => die(netErr(`bili 子进程 ${timeoutMs}ms 超时，已终止`)), timeoutMs)

  function write(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  return {
    call(method, params) {
      if (dead) return Promise.reject(deadError ?? netErr('bili 子进程已结束'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          write({ jsonrpc: '2.0', id, method, params })
        } catch {
          pending.delete(id)
          reject(netErr('bili 子进程 stdin 写入失败'))
        }
      })
    },
    notify(method, params) {
      if (dead) return
      try { write({ jsonrpc: '2.0', method, params }) } catch { /* 死了会在 call 上浮出来 */ }
    },
    get dead() { return dead },
    /** 全部调用完成后必收：停表 + 收进程（不留孤儿）。 */
    finish() {
      clearTimeout(watchdog)
      reap(child)
    }
  }
}

/** 先 kill 再等 exit；2s 还不走就 taskkill /T /F 连树清掉（真机实测 exit 在几十毫秒内）。 */
function reap(child, graceMs = REAP_GRACE_MS) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  try { child.kill() } catch { return }
  const force = setTimeout(() => {
    try {
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on?.('error', () => {})
    } catch { /* 杀不掉也只能到这儿了 */ }
  }, graceMs)
  child.once?.('exit', () => clearTimeout(force))
}

// ── 工具调用与错误映射 ────────────────────────────────────────────────────

async function callTool(session, name, args) {
  const res = await session.call('tools/call', { name, arguments: args })
  if (!res || typeof res !== 'object') throw netErr(`工具 ${name} 返回异常`)
  if (res.isError) throw toolError(name, res.content)
  const payload = res.structuredContent
  if (payload == null || typeof payload !== 'object') throw netErr(`工具 ${name} 缺 structuredContent`)
  return payload
}

/**
 * vendor 工具错误的两种形态（实测）：
 *  - 结构化 JSON（code/reason/retry_after）：412 风控 / 上游错误 → status=code，pool 按 http 分类；
 *  - 纯文本："Missing SESSDATA..."（凭据被拒）→ error_class=credentials。
 * 其余（含 "timed out" 文本）留给 pool 通用分类。
 */
function toolError(name, content) {
  const text = String(content?.[0]?.text ?? '')
  let obj = null
  try { obj = JSON.parse(text) } catch { /* 纯文本形态 */ }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.code === 412 || obj.reason === 'risk_control') {
      return fail(`B 站风控 412：${truncate(obj.message, 120)}`, { status: 412, bili: obj })
    }
    if (Number.isFinite(obj.code)) {
      // -101 = 账号未登录：cookie 过期/无效的典型形态，钉 credentials 让面板一眼看出来
      if (obj.code === -101) {
        return fail('B 站凭据被拒（code=-101 账号未登录，cookie 可能过期）', { status: -101, error_class: 'credentials', bili: obj })
      }
      return fail(`vendor 工具 ${name} 失败 code=${obj.code}（${obj.reason ?? 'upstream_error'}）`, { status: obj.code, bili: obj })
    }
  }
  if (/sessdata|credential|valid login/i.test(text)) {
    return fail(`B 站凭据被拒：${truncate(text, 120)}`, { error_class: 'credentials' })
  }
  return fail(`工具 ${name} 失败：${truncate(text, 160)}`)
}

async function handshake(session) {
  const res = await session.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'baleen', version: VERSION }
  })
  if (!res || typeof res !== 'object') throw netErr('initialize 握手失败')
  session.notify('notifications/initialized')
}

// ── RawItem 翻译 ──────────────────────────────────────────────────────────

const SUBTITLE_LOGIN_RE = /requires a valid login|SESSDATA/i

/**
 * 列表一条 + detail 一条 → RawItem。
 * 字幕两段式的裁定（计划 Task 2）：字幕全文非空 → subtitle_text + body=简介+\n\n+字幕（body_state=subtitle）；
 * 字幕空 / errors / detail 失败 → body 整个留空 → normalize 判 missing → 预筛按"无语音丢弃"。
 * 简介不救场：留着它就变 summary_only 混过预筛，违背"读不到就是读不到"。
 * burned_in 由预筛/判断侧承接，这里不判。
 */
async function toItem(session, source, v, stamped, log) {
  const bvid = String(v?.bvid ?? '').trim()
  const desc = String(v?.description ?? '').trim()

  let detail = null
  try {
    // 成本注记：每条增量视频一次 detail（一轮 ≤30 条，增量通常个位数）。
    // 列表阶段不取字幕没法判 body_state；这里单进程内逐条顺序调用，把对上游的压力压到最小。
    detail = await callTool(session, 'get_video_detail', { bvid, fetch_subtitles: true, subtitle_mode: 'smart' })
  } catch (e) {
    // 进程级故障，或风控 412/429（全局 circuit，spec §6.2：退避重试 1 次后 failed、游标不推进）
    // → 整源失败。其余（如视频已删除 -404）→ 该条降级 missing，别让一条死视频拖垮整个源。
    if (session.dead || e.status === 412 || e.status === 429) throw e
    log('bili_detail_failed', `${bvid}：${truncate(e.message, 120)}`)
  }

  const sub = detail?.subtitles ?? {}
  const fullText = String(sub.full_text ?? '').trim()
  if (!fullText && (sub.errors ?? []).some(t => SUBTITLE_LOGIN_RE.test(String(t)))) {
    log('bili_subtitle_need_login', `${bvid}：字幕需要登录态，按无字幕处理`)
  }

  const raw = {
    source_id: source.id,
    source_type: type,
    external_id: bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    title: String(v?.title ?? '').trim(),
    author: v?.author ?? null,
    published_at: intMs(detail?.video?.ctime) ?? parseStamp(v?.created_time),
    thumb: v?.pic ?? detail?.video?.pic ?? null,
    duration_sec: intOrNull(detail?.video?.duration) ?? parseLength(v?.length),
    tags: null,
    locale: null,
    fetched_at: stamped
  }
  if (fullText) {
    raw.subtitle_text = fullText
    raw.body_html = desc ? `${desc}\n\n${fullText}` : fullText
  }
  return raw
}

function intOrNull(v) {
  return Number.isFinite(v) ? Math.round(v) : null
}
function intMs(sec) {
  const n = intOrNull(sec)
  return n != null && n > 0 ? n * 1000 : null
}

// ── fetch ─────────────────────────────────────────────────────────────────

/**
 * 一次源抓取 = 一个 serve 子进程：initialize → get_user_videos → 逐条 get_video_detail。
 * `since` 有意不用于过滤（对照 rss.js）：首轮 backlog 由 gate 管，这里全量返回列表页；
 * 增量判定由 putDraft 按 external_id=bvid 去重完成。
 */
export async function fetchBili(source, {
  since = null, // 保留形参对齐适配器接口；见上，不参与过滤
  now = Date.now,
  spawnImpl = nodeSpawn,
  pref = null,
  log = () => {},
  processTimeoutMs = PROCESS_TIMEOUT_MS
} = {}) {
  if (!source?.url) throw fail('bili 源缺少 url', { error_class: 'bad_source' })
  const uid = parseSpaceUid(source.url)
  if (!uid) throw fail('bili 源 url 解析不出 UID（要形如 https://space.bilibili.com/<uid>）', { error_class: 'bad_source' })

  // 凭据：文件存在才 spawn。缺失就源级失败（credentials_missing），错误只指文件名不落内容。
  const cookiePath = path.join(homeDir(), 'credentials', 'bili-cookie.txt')
  if (!fs.existsSync(cookiePath)) {
    throw fail('B 站凭据缺失：credentials/bili-cookie.txt（纯 Cookie 头文本）不存在', { error_class: 'credentials_missing' })
  }

  const python = resolveBiliPython(pref)
  if (!fs.existsSync(python)) {
    throw netErr('bili_python 解析不到 python.exe（检查 preference 顶层 bili_python：conda 环境名或绝对路径）')
  }

  const env = { ...process.env }
  delete env.BILI_ENABLE_COOKIE_REFRESH // 审查条件 4：即使外部环境带了也不放行，凭据目录只读
  env.BILI_COOKIE_FILE = cookiePath

  const session = createSession({ spawnImpl, cmd: python, args: ['-m', 'bili_stalker_mcp', 'serve'], env, timeoutMs: processTimeoutMs })
  try {
    await handshake(session)
    const list = await callTool(session, 'get_user_videos', { user_id_or_username: uid, page: 1, limit: LIST_PAGE_SIZE })
    const videos = list?.videos
    if (!Array.isArray(videos)) throw fail('bili 视频列表响应缺 videos 数组', { parse: true })
    if (!videos.length) throw fail(`bili 视频列表为空（uid=${uid}）`, { empty: true })

    const stamped = now()
    const items = []
    for (const v of videos) {
      if (!String(v?.bvid ?? '').trim()) {
        log('bili_item_skipped', '列表项缺 bvid，跳过')
        continue
      }
      items.push(await toItem(session, source, v, stamped, log))
    }
    return items
  } finally {
    session.finish()
  }
}

export const biliAdapter = { type, fetch: fetchBili }
