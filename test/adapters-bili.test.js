import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { biliAdapter, adapterFor, ADAPTERS } from '../lib/adapters/index.js'
import { parseSpaceUid, parseLength, resolveBiliPython, fetchBiliSubtitle } from '../lib/adapters/bili.js'
import { homeDir } from '../lib/paths.js'

const source = { id: 'bili-a', type: 'bili', url: 'https://space.bilibili.com/946974', label: '某UP主' }

// ── 假子进程：EventEmitter 桩，按写入的帧回放响应 ─────────────────────────
// 真 MCP stdio 是「一行一条 JSON-RPC」（本机对 conda serve 进程实测过），
// 桩就按这个契约应答：initialize 回能力，tools/call 回 structuredContent。
import { EventEmitter } from 'node:events'

function lineChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const writes = []
  child.stdin = {
    write: (s) => { writes.push(s); return true },
    end: () => {}
  }
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  let killed = false
  child.kill = () => {
    killed = true
    // 真机实测 kill → exit 事件在十几毫秒内到；桩直接下个 tick 模拟。
    process.nextTick(() => { child.exitCode = 0; child.emit('exit', 0) })
    return true
  }
  child.killed = () => killed
  child.writes = writes
  child.reply = (msg) => child.stdout.emit('data', JSON.stringify(msg) + '\n')
  return child
}

function replyOk(child, id, structuredContent) {
  child.reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }], isError: false, structuredContent } })
}
function replyToolError(child, id, text) {
  child.reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })
}

/**
 * 可脚本化的 spawn 桩。handlers：
 *   onInitialize(msg, child)  缺省回标准 initialize 结果
 *   onCall(name, args, msg, child)  回 { structuredContent } | { toolErrorText } | { exit: 1 } | { nothing: true }
 */
function fakeSpawn(handlers = {}) {
  const state = { spawns: [], frames: [], children: [] }
  const spawnImpl = (cmd, args, opts) => {
    state.spawns.push({ cmd, args, env: opts?.env })
    const child = lineChild()
    state.children.push(child)
    const respond = (msg) => {
      state.frames.push(msg)
      if (msg.method === 'initialize') {
        if (handlers.onInitialize) return handlers.onInitialize(msg, child)
        child.reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } })
        return
      }
      if (msg.method === 'notifications/initialized') return
      if (msg.method === 'tools/call') {
        const r = handlers.onCall?.(msg.params.name, msg.params.arguments, msg, child) ?? { nothing: true }
        if (r.nothing) return
        if (r.exit != null) { child.exitCode = r.exit; child.emit('exit', r.exit); return }
        if (r.toolErrorText != null) return replyToolError(child, msg.id, r.toolErrorText)
        return replyOk(child, msg.id, r.structuredContent)
      }
    }
    const origWrite = child.stdin.write
    child.stdin.write = (s) => {
      origWrite(s)
      for (const line of String(s).split('\n')) if (line.trim()) respond(JSON.parse(line))
      return true
    }
    return child
  }
  spawnImpl.state = state
  return spawnImpl
}

// ── 夹具：vendor get_user_videos / get_video_detail 的 structuredContent 形态 ──
const LIST = () => ({
  videos: [
    {
      bvid: 'BV1xx411c7mD', aid: 170001, title: 'DSH 插件实战第一期', description: '这期讲适配器怎么写',
      author: 'UP主甲', length: '12:34', created_time: '2026-10-24 18:30', play: 1024, review: 8,
      pic: '//i0.hdslb.com/bfs/archive/cover1.jpg'
    },
    {
      bvid: 'BV1yy411c7mE', aid: 170002, title: '没有字幕的一期', description: '纯画面演示',
      author: 'UP主甲', length: '3:05', created_time: '2026-10-23 09:00', pic: null
    }
  ],
  total: 2
})
const DETAIL_WITH_SUB = () => ({
  video: { bvid: 'BV1xx411c7mD', title: 'DSH 插件实战第一期', desc: '这期讲适配器怎么写', publish_time: '2026-10-24 18:30', owner: { mid: 946974, name: 'UP主甲' }, duration: 754, pic: '//i0.hdslb.com/bfs/archive/cover1.jpg', ctime: 1799848200, tags: ['编程'] },
  subtitles: { enabled: true, mode: 'smart', full_text: '大家好，今天讲适配器。', truncated: false, errors: [] }
})
const DETAIL_NO_SUB = () => ({
  video: { bvid: 'BV1yy411c7mE', title: '没有字幕的一期', desc: '纯画面演示', duration: 185, ctime: 1799754000 },
  subtitles: { enabled: true, mode: 'smart', full_text: '', truncated: false, errors: ['cid 2: Bilibili requires a valid login to return subtitle tracks; configured SESSDATA was not authenticated'] }
})

const defaultHandlers = (over = {}) => ({
  onCall(name, args) {
    if (name === 'get_user_videos') return { structuredContent: over.list ?? LIST() }
    if (name === 'get_video_detail') return { structuredContent: (args.bvid === 'BV1xx411c7mD' ? (over.detail1 ?? DETAIL_WITH_SUB) : (over.detail2 ?? DETAIL_NO_SUB))() }
    return { toolErrorText: `Unknown tool: ${name}` }
  },
  ...over
})

// 建临时 BALEEN_HOME + 凭据文件，返回清理函数
async function withHome(t, { cookie = true } = {}) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'baleen-bili-test-'))
  const prev = process.env.BALEEN_HOME
  process.env.BALEEN_HOME = home
  if (cookie) {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials', 'bili-cookie.txt'), 'SESSDATA=fake-value; bili_jct=fake\n', 'utf8')
  }
  t.after(() => {
    if (prev === undefined) delete process.env.BALEEN_HOME
    else process.env.BALEEN_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

const fetchIt = (spawnImpl, over = {}) => biliAdapter.fetch(source, { since: null, now: () => 1730000000000, spawnImpl, pref: { bili_python: 'baleen-bili' }, ...over })

// ── 帧握手与 tools/call 编解码 ────────────────────────────────────────────

test('握手与调用帧：initialize → notifications/initialized → tools/call，参数对齐 vendor 工具 schema', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  const items = await fetchIt(spawnImpl)
  assert.equal(items.length, 2)

  const frames = spawnImpl.state.frames
  assert.equal(frames[0].method, 'initialize')
  assert.ok(frames[0].params.protocolVersion)
  assert.equal(frames[0].params.clientInfo.name, 'baleen')
  assert.equal(frames[1].method, 'notifications/initialized')
  assert.equal(frames[2].method, 'tools/call')
  assert.equal(frames[2].params.name, 'get_user_videos')
  assert.deepEqual(frames[2].params.arguments, { user_id_or_username: '946974', page: 1, limit: 30 })
  assert.equal(frames[3].params.name, 'get_video_detail')
  assert.deepEqual(frames[3].params.arguments, { bvid: 'BV1xx411c7mD', fetch_subtitles: true, subtitle_mode: 'smart' })
})

test('spawn 形态：conda python -m bili_stalker_mcp serve；凭据经 BILI_COOKIE_FILE 注入；cookie 自动回写 env 被剥离', async () => {
  const home = await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  await fetchIt(spawnImpl)

  const { cmd, args, env } = spawnImpl.state.spawns[0]
  assert.match(cmd, /python\.exe$/i)
  assert.deepEqual(args, ['-m', 'bili_stalker_mcp', 'serve'])
  const cookiePath = path.join(homeDir(), 'credentials', 'bili-cookie.txt')
  assert.equal(env.BILI_COOKIE_FILE, cookiePath)
  assert.ok(fs.existsSync(cookiePath))
  assert.equal(env.BILI_ENABLE_COOKIE_REFRESH, undefined)
})

test('bili_python 配置：绝对路径直接用；环境名按 <root>/envs/<名>/python.exe 解析', () => {
  assert.equal(resolveBiliPython({ bili_python: 'D:\\MyPy\\python.exe' }), 'D:\\MyPy\\python.exe')
  assert.equal(resolveBiliPython({}), path.join('D:\\Miniconda', 'envs', 'baleen-bili', 'python.exe'))
  process.env.BALEEN_CONDA_ROOT = 'D:\\Tools\\mamba'
  try {
    assert.equal(resolveBiliPython({ bili_python: 'myenv' }), path.join('D:\\Tools\\mamba', 'envs', 'myenv', 'python.exe'))
  } finally {
    delete process.env.BALEEN_CONDA_ROOT
  }
})

// ── RawItem 翻译 ──────────────────────────────────────────────────────────

test('RawItem 翻译：bvid 作 external_id、封面 pic、时长取 detail 总秒、published_at 取 ctime 毫秒', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  const items = await fetchIt(spawnImpl)

  const a = items[0]
  assert.equal(a.source_id, 'bili-a')
  assert.equal(a.source_type, 'bili')
  assert.equal(a.external_id, 'BV1xx411c7mD')
  assert.equal(a.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(a.title, 'DSH 插件实战第一期')
  assert.equal(a.author, 'UP主甲')
  assert.equal(a.thumb, '//i0.hdslb.com/bfs/archive/cover1.jpg')
  assert.equal(a.duration_sec, 754)
  assert.equal(a.published_at, 1799848200 * 1000)
  assert.equal(a.fetched_at, 1730000000000)
  assert.equal(a.tags, null)
  assert.equal(a.locale, null)
})

test('字幕拼接：有字幕 → subtitle_text + body=简介\\n\\n字幕全文；无字幕 → body 留空（missing 交给预筛）', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  const [a, b] = await fetchIt(spawnImpl)

  assert.equal(a.subtitle_text, '大家好，今天讲适配器。')
  assert.equal(a.body_html, '这期讲适配器怎么写\n\n大家好，今天讲适配器。')
  // 无字幕那条：不写 body / subtitle_text，normalize 才会判 missing
  assert.equal(b.subtitle_text, undefined)
  assert.equal(b.body_html, undefined)
  assert.equal(b.external_id, 'BV1yy411c7mE')
  assert.equal(b.duration_sec, 185)
})

test('detail 单条失败不拖垮整源：失败条降级 missing 并留诊断日志，其余照常', async () => {
  await withHome(test)
  const logs = []
  const spawnImpl = fakeSpawn({
    onCall(name, args) {
      if (name === 'get_user_videos') return { structuredContent: LIST() }
      if (name === 'get_video_detail' && args.bvid === 'BV1xx411c7mD') return { toolErrorText: 'vendor 工具失败：video detail query failed (code: -404)' }
      return DETAIL_NO_SUB()
    }
  })
  const items = await fetchIt(spawnImpl, { log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(items.length, 2)
  assert.equal(items[0].subtitle_text, undefined)
  assert.equal(items[0].body_html, undefined)
  assert.equal(items[1].subtitle_text, undefined)
  assert.ok(logs.some(l => l.event === 'bili_detail_failed' && l.detail.includes('BV1xx411c7mD')))
})

test('detail 撞上风控 412 → 整源失败（游标不推进），不降级 missing', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall(name) {
      if (name === 'get_user_videos') return { structuredContent: LIST() }
      return { toolErrorText: JSON.stringify({ code: 412, reason: 'risk_control', retry_after: 30, message: 'circuit open' }) }
    }
  })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.status === 412)
})

test('vendor code=-101（账号未登录）→ error_class=credentials', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall: () => ({ toolErrorText: JSON.stringify({ code: -101, reason: 'upstream_error', message: 'BiliStalkerMCP request failed.' }) })
  })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.error_class === 'credentials' && e.status === -101)
})

test('字幕需登录（need_login 类 errors）→ 该条按无字幕处理 + 诊断日志一行', async () => {
  await withHome(test)
  const logs = []
  const spawnImpl = fakeSpawn(defaultHandlers())
  await fetchIt(spawnImpl, { log: (event, detail) => logs.push({ event, detail }) })
  assert.ok(logs.some(l => l.event === 'bili_subtitle_need_login' && l.detail.includes('BV1yy411c7mE')))
})

test('since 不过滤（backlog 语义由 gate 管）：created_time 很旧的条目照样返回', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  const items = await fetchIt(spawnImpl, { since: 4102444800000 }) // 2100 年，比所有条目都新
  assert.equal(items.length, 2)
})

// ── 错误映射 ──────────────────────────────────────────────────────────────

test('凭据缺失：不 spawn、error_class=credentials_missing、消息只指向文件名不带绝对路径', async () => {
  await withHome(test, { cookie: false })
  const spawnImpl = fakeSpawn(defaultHandlers())
  await assert.rejects(
    () => fetchIt(spawnImpl),
    e => {
      assert.equal(e.error_class, 'credentials_missing')
      assert.match(e.message, /bili-cookie\.txt/)
      assert.doesNotMatch(e.message, /[/\\]credentials[/\\]/) // 只说文件名，不落绝对路径
      assert.equal(spawnImpl.state.spawns.length, 0)
      return true
    }
  )
})

test('凭据被拒（Missing SESSDATA 文本）→ error_class=credentials', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({ onCall: () => ({ toolErrorText: 'Missing SESSDATA. Set SESSDATA or provide BILI_COOKIE_FILE.' }) })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.error_class === 'credentials')
})

test('源 url 无 UID → error_class=bad_source，且不 spawn', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  await assert.rejects(
    () => biliAdapter.fetch({ id: 'b', type: 'bili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, { spawnImpl }),
    e => e.error_class === 'bad_source' && spawnImpl.state.spawns.length === 0
  )
})

test('vendor 结构化风控错误（code=412 JSON）→ e.status=412（pool 按 http 分类）', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall: () => ({ toolErrorText: JSON.stringify({ code: 412, reason: 'risk_control', retry_after: 30, message: 'Bilibili returned 412.' }) })
  })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.status === 412 && e.bili?.reason === 'risk_control')
})

test('子进程中途退出（exit 1）→ error_class=network', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall(name) {
      if (name === 'get_user_videos') return { exit: 1 }
      return { structuredContent: LIST() }
    }
  })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.error_class === 'network' && /退出|exit/i.test(e.message))
})

test('子进程 spawn 失败（error 事件）→ error_class=network', async () => {
  await withHome(test)
  // error 事件在 initialize 等待期间同步发（真 ENOENT 也是起进程阶段就死），
  // 不用 nextTick —— 那会在顶层 await 语境下晚于整条微任务链，时序不可靠。
  const spawnImpl = fakeSpawn({
    onInitialize: (msg, child) => { child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })) }
  })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.error_class === 'network')
})

test('单进程超时（注入短 watchdog）→ error_class=network，子进程被 kill 不留孤儿', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall(name) {
      if (name === 'get_user_videos') return { nothing: true } // 永不响应
      return { structuredContent: LIST() }
    }
  })
  await assert.rejects(() => fetchIt(spawnImpl, { processTimeoutMs: 40 }), e => e.error_class === 'network' && /超时/.test(e.message))
  assert.equal(spawnImpl.state.children[0].killed(), true)
})

test('fetch 结束子进程必收：正常路径也 kill', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn(defaultHandlers())
  await fetchIt(spawnImpl)
  assert.equal(spawnImpl.state.children[0].killed(), true)
})

test('列表为 0 条 → e.empty（它不算成功，游标不能推进）', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({ onCall: () => ({ structuredContent: { videos: [], total: 0 } }) })
  await assert.rejects(() => fetchIt(spawnImpl), e => e.empty === true)
})

// ── fetchBiliSubtitle：baleen.subtitle 工具的后端（M4a Task 3） ───────────

const subFetch = (spawnImpl, over = {}) => fetchBiliSubtitle('BV1xx411c7mD', { spawnImpl, pref: { bili_python: 'baleen-bili' }, ...over })

test('fetchBiliSubtitle：单进程 initialize → get_video_detail(bvid)，返回 trim 后字幕全文，结束必收进程', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({
    onCall(name) {
      if (name === 'get_video_detail') return { structuredContent: DETAIL_WITH_SUB() }
      return { toolErrorText: `Unknown tool: ${name}` }
    }
  })
  const text = await subFetch(spawnImpl)
  assert.equal(text, '大家好，今天讲适配器。')

  const frames = spawnImpl.state.frames
  assert.equal(frames[0].method, 'initialize')
  assert.equal(frames[1].method, 'notifications/initialized')
  assert.equal(frames[2].params.name, 'get_video_detail')
  assert.deepEqual(frames[2].params.arguments, { bvid: 'BV1xx411c7mD', fetch_subtitles: true, subtitle_mode: 'smart' })
  assert.equal(spawnImpl.state.children[0].killed(), true)
})

test('fetchBiliSubtitle：full_text 为空 → 返回空串（no_subtitle 由调用方裁定）', async () => {
  await withHome(test)
  const spawnImpl = fakeSpawn({ onCall: () => ({ structuredContent: DETAIL_NO_SUB() }) })
  const text = await fetchBiliSubtitle('BV1yy411c7mE', { spawnImpl, pref: { bili_python: 'baleen-bili' } })
  assert.equal(text, '')
})

test('fetchBiliSubtitle：字幕需登录的 errors → 照留 bili_subtitle_need_login 诊断一行', async () => {
  await withHome(test)
  const logs = []
  const spawnImpl = fakeSpawn({ onCall: () => ({ structuredContent: DETAIL_NO_SUB() }) })
  await fetchBiliSubtitle('BV1yy411c7mE', { spawnImpl, pref: { bili_python: 'baleen-bili' }, log: (event, detail) => logs.push({ event, detail }) })
  assert.ok(logs.some(l => l.event === 'bili_subtitle_need_login' && l.detail.includes('BV1yy411c7mE')))
})

test('fetchBiliSubtitle：412 原样上浮；凭据缺失 credentials_missing 且不 spawn；bvid 空 bad_source 不 spawn', async () => {
  await withHome(test)
  const risk = fakeSpawn({
    onCall: () => ({ toolErrorText: JSON.stringify({ code: 412, reason: 'risk_control', retry_after: 30, message: 'circuit open' }) })
  })
  await assert.rejects(() => subFetch(risk), e => e.status === 412 && e.bili?.reason === 'risk_control')

  await withHome(test, { cookie: false })
  const noCookie = fakeSpawn({ onCall: () => ({ structuredContent: DETAIL_WITH_SUB() }) })
  await assert.rejects(
    () => subFetch(noCookie),
    e => e.error_class === 'credentials_missing' && noCookie.state.spawns.length === 0
  )

  await withHome(test)
  const noBvid = fakeSpawn()
  await assert.rejects(
    () => fetchBiliSubtitle('   ', { spawnImpl: noBvid, pref: { bili_python: 'baleen-bili' } }),
    e => e.error_class === 'bad_source'
  )
  assert.equal(noBvid.state.spawns.length, 0)
})

// ── 注册与工具函数 ────────────────────────────────────────────────────────

test('adapterFor 注册 bili；parseSpaceUid/parseLength 按契约解析', () => {
  assert.equal(adapterFor('bili'), ADAPTERS.bili)
  assert.equal(adapterFor('Bili'), ADAPTERS.bili)
  assert.equal(adapterFor('xhs'), null)

  assert.equal(parseSpaceUid('https://space.bilibili.com/946974'), '946974')
  assert.equal(parseSpaceUid('https://space.bilibili.com/946974?spm_id_from=x'), '946974')
  assert.equal(parseSpaceUid('https://www.bilibili.com/video/BV1x'), null)
  assert.equal(parseSpaceUid(null), null)

  assert.equal(parseLength('12:34'), 754)
  assert.equal(parseLength('1:02:03'), 3723)
  assert.equal(parseLength(''), null)
  assert.equal(parseLength(null), null)
})
