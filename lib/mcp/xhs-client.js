import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../paths.js'

/**
 * xhs-client —— 小红书 MCP（xiaohongshu-mcp 官方 exe）的 HTTP 客户端 + 子进程生命周期。
 *
 * 选型与边界见 docs/v3-xhs-mcp-audit.md（V3）与 docs/superpowers/plans/2026-11-01-baleen-m6-xhs.md：
 *  - 只读白名单：9 个只读工具之外的名字在这里就被拒掉，零 HTTP 往返——写平台动作
 *    （发布/点赞/收藏/评论，共 8 个）永远不从 baleen 调用，也永远不进 agent 工具面（红线）；
 *  - 子进程由 baleen 拉起：回环绑定 + 每 boot 随机 token（spawn 侧与 HTTP 侧同源，
 *    不落盘不进日志）；cookie 收敛在 <home>/credentials/xhs-cookies.json（凭据只落本机）；
 *  - 惰性 spawn：配了 xhs 源才会拉子进程；首次运行官方 exe 会先下载内置浏览器
 *    （约 140-190MB，带 SHA256 校验），那一轮的源请求会按 mcp_unready 失败，下一轮自然恢复。
 */

/** 只读工具白名单（V3 审查清单逐字）。工具面对 agent 仍恰好六个，这里是摄取内部面。 */
export const XHS_READ_TOOLS = new Set([
  'check_login_status', 'get_login_qrcode', 'get_feed_detail', 'get_unread_count',
  'list_feeds', 'list_notifications', 'search_feeds', 'user_profile', 'get_my_profile'
])

/** 端口就绪探测预算：浏览器已缓存时秒级；首次下载内置浏览器的那一轮等不到，如实报 mcp_unready。 */
const READY_TIMEOUT_MS = 20000
const READY_POLL_MS = 300

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}

let active = null // { key, baseUrl, token, port, child, client }

/** 供测试与 baleen 的 ctx.effect 清理用。 */
export function stopXhsMcp() {
  if (active?.child) {
    try { active.child.kill() } catch { /* 已死即成功 */ }
  }
  active = null
}

/**
 * 取（必要时拉起）小红书 MCP 的 HTTP 客户端。幂等：同一份 (exePath, port) 配置复用
 * 已在跑的实例；配置变了才重启。mcp_path 空 / exe 不存在 → mcp_missing。
 */
export async function getXhsMcp(pref, log = () => {}) {
  const cfg = pref?.xhs
  if (!cfg?.mcp_path || !String(cfg.mcp_path).trim()) {
    throw fail('xhs.mcp_path 未配置——小红书通道不启用（要启用就填官方 exe 路径）', { error_class: 'mcp_missing' })
  }
  const exePath = String(cfg.mcp_path).trim()
  if (!fs.existsSync(exePath)) {
    throw fail(`xhs MCP exe 不存在: ${exePath}`, { error_class: 'mcp_missing' })
  }
  const port = Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : 18060
  const key = `${exePath}|${port}`
  if (active?.key === key && active.listening) return active.client

  stopXhsMcp()
  const token = randomBytes(24).toString('hex')
  const cookiesPath = path.join(homeDir(), 'credentials', 'xhs-cookies.json')
  fs.mkdirSync(path.dirname(cookiesPath), { recursive: true })

  const child = spawn(exePath, ['-port', `127.0.0.1:${port}`, '-token', token], {
    cwd: path.dirname(cookiesPath),
    env: { ...process.env, AUTH_TOKEN: token, COOKIES_PATH: cookiesPath },
    stdio: 'ignore'
  })
  const record = { key, baseUrl: `http://127.0.0.1:${port}`, token, port, child, listening: false, client: null }
  active = record

  await waitListening(port, READY_TIMEOUT_MS)
  record.listening = true
  record.client = makeClient(record, log)
  log('xhs_mcp_up', `小红书 MCP 已就绪（127.0.0.1:${port}）`)
  return record.client
}

/** 供 ctx.effect 注册清理；没拉起过就是空操作。 */
export function xhsMcpRunning() {
  return Boolean(active?.child)
}

function waitListening(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tryOnce = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) {
          reject(fail(`xhs MCP 在 ${timeoutMs}ms 内没监听上 127.0.0.1:${port}——若是首次运行，多半还在下载内置浏览器（约 140-190MB），下一轮自然恢复`, { error_class: 'mcp_unready' }))
        } else {
          setTimeout(tryOnce, READY_POLL_MS)
        }
      })
    }
    tryOnce()
  })
}

/** 单个 MCP 客户端实例：会话惰性建立、404 过期自动重初始化一次。 */
function makeClient(record, log = () => {}) {
  let sessionId = null
  let rpcId = 0

  const headers = () => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + record.token,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
  })

  async function rpc(method, params, isNotification = false) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(isNotification ? {} : { id: ++rpcId }) }
    const res = await fetch(record.baseUrl + '/mcp', { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: params?.signal })
    const sid = res.headers.get('mcp-session-id')
    if (sid && !sessionId) sessionId = sid
    const ct = res.headers.get('content-type') || ''
    let payload = null
    if (ct.includes('event-stream')) {
      const text = await res.text()
      const dataLines = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      payload = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1]) : null
    } else {
      const text = await res.text()
      payload = text ? JSON.parse(text) : null
    }
    return { res, payload }
  }

  async function ensureSession() {
    const { res } = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'baleen-xhs', version: '0.1.0' }
    })
    if (res.status !== 200) throw fail(`xhs MCP initialize HTTP ${res.status}`, { error_class: 'mcp_unready' })
    await rpc('notifications/initialized', undefined, true)
  }

  /**
   * 调一个只读工具，返回 { texts: string[], images: [] }。白名单外的名字在这里
   * 就地拒绝（零 HTTP 往返）——写平台动作从结构上进不了调用链。
   */
  async function callTool(name, args = {}) {
    if (!XHS_READ_TOOLS.has(name)) {
      throw fail(`工具 "${name}" 不在小红书只读白名单里——baleen 对写平台动作零调用`, { error_class: 'xhs_tool_forbidden' })
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!sessionId) await ensureSession()
      const { res, payload } = await rpc('tools/call', { name, arguments: args })
      if (res.status === 404 || (payload?.error && /session/i.test(payload.error.message || ''))) {
        sessionId = null // 会话过期：重初始化一次再试
        continue
      }
      if (res.status === 401) throw fail('xhs MCP 鉴权被拒——token 与子进程不同源，属内部错误', { error_class: 'mcp_unready' })
      if (payload?.error) throw fail(`xhs MCP ${name}: ${payload.error.message ?? '未知错误'}`, { error_class: 'xhs_tool_error' })
      const content = payload?.result?.content ?? []
      return {
        texts: content.filter((x) => x.type === 'text').map((x) => x.text),
        images: content.filter((x) => x.type === 'image')
      }
    }
    throw fail('xhs MCP 会话两次初始化都失败', { error_class: 'mcp_unready' })
  }

  /** check_login_status 的结构化视图：{ loggedIn, username?, raw }。 */
  async function checkLoginStatus() {
    const { texts } = await callTool('check_login_status')
    const text = texts.join('\n')
    const loggedIn = /✅\s*已登录/.test(text)
    const name = loggedIn ? (/用户名:\s*(.+)/.exec(text)?.[1]?.trim() ?? '') : ''
    return { loggedIn, username: name, raw: text }
  }

  /** search_feeds：返回解析后的 { feeds: [...] }（工具以 JSON 文本回内容）。 */
  async function searchFeeds(keyword) {
    const { texts } = await callTool('search_feeds', { keyword })
    return parseJsonTool(texts, 'search_feeds')
  }

  /** get_feed_detail：返回解析后的笔记详情 JSON。 */
  async function getFeedDetail(noteId, xsecToken) {
    const { texts } = await callTool('get_feed_detail', { feed_id: noteId, xsec_token: xsecToken })
    return parseJsonTool(texts, 'get_feed_detail')
  }

  return { callTool, checkLoginStatus, searchFeeds, getFeedDetail }
}

/** 供测试打桩：对固定 baseUrl/token 的裸 HTTP 客户端（不经 spawn、不碰磁盘）。 */
export function createXhsHttpClient(baseUrl, token, log = () => {}) {
  return makeClient({ baseUrl, token }, log)
}

/** 工具把 JSON 以 text 形态回（搜索/详情都这样），这里统一解析；坏 JSON 如实抛。 */
function parseJsonTool(texts, tool) {
  const text = texts.join('\n').trim()
  if (!text) throw fail(`xhs MCP ${tool} 返回空内容`, { error_class: 'xhs_tool_error' })
  try { return JSON.parse(text) } catch (e) {
    throw fail(`xhs MCP ${tool} 返回的不是 JSON: ${text.slice(0, 80)}`, { error_class: 'xhs_tool_error', parse: true })
  }
}
