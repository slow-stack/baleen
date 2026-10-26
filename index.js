import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { openStore, migrate, counts, listItems, listSources, lastRun, getCursor, markFeedback, listFolders, createFolder, renameFolder, deleteFolder, setItemFolders, foldersOfItem, itemsWithFolders, candidates, latestDigests, exportItems, wipeLibrary } from './lib/store.js'
import { loadPreference, ensurePreferenceFile, bumpTuningFile, writePreference, readPreferenceRaw, clearTuningFile, validate } from './lib/preference.js'
import { runOnce, syncSources } from './lib/runner.js'
import { createScheduler } from './lib/scheduler.js'
import { makeLogger, redact } from './lib/diag.js'
import { ensureHome } from './lib/paths.js'
import { baleenTools } from './lib/tools.js'

export const name = 'dsh-baleen'
// 'tools' 是判断轮的工具面；'systemPrompt' 是待判注入段（ctx.inject(['systemPrompt'], ...) 的服务依赖）。
// 宿主按这份清单等服务就绪后才调 apply——照抄 dsh-mneme 在当前宿主上的声明形态。
export const inject = ['tools', 'systemPrompt', 'webServer']

const API_ROUTE = '/api/dsh-baleen'

/** 面板两个按钮允许的动作，与客户端白名单一致；值就是对来源权重的增量 */
const ALLOWED_ACTIONS = { dismiss: -0.1, save: 0.1 }

/**
 * 设置页 PUT 允许写的节（白名单）。tuning 与 version 永不在此列：
 * tuning 只走 /feedback 与 /tuning-reset，version 没有升级路径可写。
 * yt_dlp_path / network 这类进阶键留给手编文件，页签不碰。
 */
const PREF_SECTIONS = new Set(['sources', 'follow', 'themes', 'redlines', 'schedule', 'limits', 'charter', 'require_theme_hit', 'inject_prompt'])

/** 夹操作是白名单而不是 if 链：新加动作时漏了枚举就直接 400，不会悄悄走进某个分支 */
const FOLDER_ACTIONS = new Set(['create', 'rename', 'delete'])

/** store 抛的是短码（name_taken / bad_name / …），这里只负责翻成 HTTP 语义 */
const FOLDER_ERRORS = { name_taken: 409, name_too_long: 400, bad_name: 400, no_folder: 404, default_folder: 403 }

/**
 * /collect 自己的夹错误契约：no_folder 对齐 missing 扫描的 410（folder_gone 同源），
 * 不沿用 /folder 路由的 404。当前实际不可达——missing 扫描在前拦截，能把
 * setItemFolders 逼出 no_folder 的夹 id 都已验证过存在；钉住这一行是防将来把
 * 校验重排进 store 时，契约静默退回 404。
 */
const COLLECT_ERRORS = { ...FOLDER_ERRORS, no_folder: 410 }

function readBody(req) {
  if (typeof req?.rawBody === 'string') return Promise.resolve(req.rawBody)
  if (!req || typeof req.on !== 'function') return Promise.resolve('')
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 查询参数一律消毒：`?limit=abc` 应该按默认值走，而不是把路由打成 500。
 * 参数缺席（null）也必须走默认值——Number(null) === 0，不挡住就会把"没传 limit"
 * 变成"limit=0"，收藏页不带 limit 取数时会拿到空列表（老测试库全是空的，从没暴露过这条）。
 */
function num(v, dflt, max) {
  if (v == null || v === '') return dflt
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? Math.min(max, n) : dflt
}

/* ---------------- 判断轮的触发注入（spec §10.2） ---------------- */

/** 注入有 ≤200 字的硬顶：标题与源 id 都不许整段放行，超长截断加省略号 */
function clipText(s, n) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 上轮失败源 id：per_source 里 ok=false 的键，最多 3 个；run 缺席 / 半途 / 坏 JSON 都按"无失败源"处理 */
function failedSourceIds(run) {
  if (!run?.per_source_json) return []
  let ps
  try { ps = JSON.parse(run.per_source_json) } catch { return [] }
  if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return []
  return Object.entries(ps)
    .filter(([, s]) => s && s.ok === false)
    .map(([id]) => clipText(id, 12))
    .slice(0, 3)
}

/**
 * 注入文本。这是**触发器不是内容管道**（spec §10.2 红线）：只带待判数、Top 标题前 20 字与工具名，
 * 条目正文一字不进、URL 不进、themes/charter 等用户可编辑文本不进。
 * 候选 0 且无失败源时返回 null——不给会话添噪音，一句废话都不说。
 */
function pendingSectionText(db) {
  const c = counts(db)
  const run = lastRun(db)
  const failed = failedSourceIds(run)
  if (c.new === 0 && failed.length === 0) return null
  const segs = []
  if (c.new > 0) {
    const top = candidates(db, 3).map((r) => clipText(r.title, 20) || '无标题')
    segs.push(`待判 ${c.new} 条（Top：${top.join('；')}）`)
  }
  if (failed.length) segs.push(`上轮源：失败 ${failed.join('；')}`)
  else if (run && run.status !== 'running') segs.push('上轮源：全部正常')
  segs.push('可用工具：baleen_candidates / read_item / save_verdicts')
  return `Baleen：${segs.join('。')}。`
}

/**
 * digests 的行整形：stats_json 是存储形态，/state 是面板的 API——在这里解成对象，
 * 前端不该知道存储格式（计划 Task 4 的裁定）。解析失败按 null 处理，
 * 前端拿到 null 就说"这份汇报的计数没读出来"，不装作没有这一栏。
 */
function digestRows(rows) {
  return rows.map((d) => {
    let stats = null
    try { stats = d.stats_json ? JSON.parse(d.stats_json) : null } catch { stats = null }
    return { id: d.id, headline: d.headline, created_at: d.created_at, stats }
  })
}

/* ---------------- 凭据与环境（M5 Task 2，设置页的宿主半） ---------------- */

/**
 * bili 凭据文件的现状：只报存在性与 mtime 毫秒。内容一个字都不许出这条函数——
 * 状态、应答、日志三处都是零回显（红线），读文件取内容的只有 bili 适配器的 readCookieFile。
 */
function credentialState(file) {
  try {
    return { present: true, updated_at: fs.statSync(file).mtimeMs }
  } catch {
    return { present: false, updated_at: null }
  }
}

/** env-check 探测的存活时间与硬超时（探测只要 --version，30s 足够且绝不吃进抓取预算） */
const YTDLP_PROBE_TTL_MS = 10 * 60 * 1000
const YTDLP_PROBE_TIMEOUT_MS = 30000

/**
 * yt-dlp 版本探测（env-check 用）：spawn `--version`，任何失败（ENOENT / 非零退出 /
 * 超时 / 输出为空）一律回 null——探测是给面板看的，不是给系统下结论的。
 * 结果按二进制名缓存 10 分钟（含失败），面板反复刷新不该变成每次一个子进程。
 * 二进制解析与抓取侧同源：用户改过 yt_dlp_path 就用它，缺省在 Windows 上显式补
 * .exe（spawn 无 shell 时不走 PATHEXT，libuv 的扩展搜索在不同安装形态下踩过坑）。
 */
function makeYtDlpProbe({ spawnImpl, getPref, now }) {
  const cache = new Map() // bin → { at, version }
  return async () => {
    const configured = String(getPref().pref.yt_dlp_path ?? '').trim()
    const bin = configured && configured !== 'yt-dlp'
      ? configured
      : (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    const hit = cache.get(bin)
    if (hit && now() - hit.at < YTDLP_PROBE_TTL_MS) return hit.version
    const version = await new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch {
        resolve(null) // 同步抛（典型是 ENOENT）也是"不可用"，不是路由错误
        return
      }
      let out = ''
      let settled = false
      let timer = null
      const settle = (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      child.stdout?.on('data', (c) => { out += String(c) })
      child.stderr?.on('data', () => {}) // 挂住 stderr 防满管阻塞子进程
      timer = setTimeout(() => { try { child.kill() } catch {} settle(null) }, YTDLP_PROBE_TIMEOUT_MS)
      child.on?.('error', () => settle(null))
      child.on?.('exit', (code) => settle(code === 0 && out.trim() ? out.split(/\r?\n/)[0].trim().slice(0, 40) : null))
    })
    cache.set(bin, { at: now(), version })
    return version
  }
}

/* ---------------- 库管理（M5 Task 3，设置页的宿主半） ---------------- */

/** 文件名时间戳段：yyyymmdd-HHmmss 本地时间——用户回看文件时念的是自己的钟 */
function stampOf(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出行里的 published_at：本地时间；没有就老实写时间未知 */
function fmtLocal(ms) {
  if (!Number.isInteger(ms) || ms < 0) return '时间未知'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 导出正文：`## <source_id>` 分组头 + 每条 `- [标题](url)｜档位·理由｜本地时间｜body_state`。
 * 未判条目档位写「未判」——导出是给用户看的账本，没判就明说，不装作漏了。
 * 标题里的空白折叠成单个空格：源数据里的换行会把"一行一条"的清单撕开。
 */
function exportMarkdown(rows) {
  const lines = ['# Baleen 导出', '']
  let cur = null
  for (const r of rows) {
    if (r.source_id !== cur) {
      if (cur !== null) lines.push('')
      cur = r.source_id
      lines.push(`## ${cur}`)
    }
    const tier = r.verdict_tier ?? '未判'
    const why = r.verdict_why ? `·${r.verdict_why}` : ''
    const title = String(r.title ?? '').replace(/\s+/g, ' ').trim() || '无标题'
    lines.push(`- [${title}](${r.url})｜${tier}${why}｜${fmtLocal(r.published_at)}｜${r.body_state}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * VACUUM INTO 备份（cleanup/wipe 的第一动作）：主库连同 WAL 已提交内容拍成一个
 * 能独立打开的快照。VACUUM INTO 拒绝覆盖已存在的文件（实测报 output file already
 * exists），同一秒里的第二次危险操作不该因此 500，撞名加序号。返回值只有文件名——
 * 路径段永远不进应答与日志。
 */
function backupDb(db, dir, now) {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
  const base = `baleen-${stampOf(now())}`
  let name = `${base}.sqlite`
  for (let i = 2; fs.existsSync(path.join(dir, 'backups', name)); i++) name = `${base}-${i}.sqlite`
  db.prepare('VACUUM INTO ?').run(path.join(dir, 'backups', name))
  return name
}

/**
 * 宿主半入口。三件事：装配（库 + 偏好 + 调度）、只读路由、给面板与别的插件一个服务入口。
 *
 * 路由注册写法抄本机 dsh-study-desk 的实测形态：`webServer.register({kind:'prefix', path, handler})`
 * 包在 `ctx.effect` 里，且桌面端 UI 跑在自定义协议上——**只有 /api/* 会被转发到宿主**，
 * 所以路由前缀不能改。
 */
export function apply(ctx, config = {}) {
  const dir = ensureHome()
  const now = config.now ?? Date.now
  const log = makeLogger({ dir })
  const prefs = ensurePreferenceFile(dir)
  const { db } = openStore(path.join(dir, 'baleen.sqlite'))
  migrate(db)

  const getPref = () => loadPreference(dir)
  // 启动时就把偏好里的源镜像进表，否则面板要等第一轮跑完才看得到源列表
  // （表是运行态，偏好是真源；只在 runOnce 里同步会让"配置了但还没到点"看起来像没配）。
  const boot = getPref()
  if (!boot.errors.length) syncSources(db, boot.pref)
  // 定时器可注入：测试里必须注入，否则一个 5 分钟的 interval 会把测试进程吊住不退出。
  const scheduler = createScheduler({
    db, getPref, runOnce, log,
    now,
    tickMin: Number.isFinite(config.tickMin) ? config.tickMin : 5,
    setInterval: config.setInterval ?? setInterval,
    clearInterval: config.clearInterval ?? clearInterval
  })
  // 凭据文件路径与 yt-dlp 探测器（设置页 Task 2）。spawnImpl 走 config 透传，与
  // subtitle 工具同一个注入口；探测缓存落在闭包里——跟随插件生命周期，不跨实例串味。
  const credFile = path.join(dir, 'credentials', 'bili-cookie.txt')
  const probeYtDlp = makeYtDlpProbe({ spawnImpl: config.spawnImpl ?? spawn, getPref, now })

  function state() {
    const { pref, errors } = getPref()
    const prev = lastRun(db)
    let gaps = null
    try { gaps = prev?.gaps_json ? JSON.parse(prev.gaps_json) : null } catch { gaps = null }
    return {
      home: '<HOME>',
      counts: counts(db),
      digest_count: db.prepare('SELECT COUNT(*) n FROM digests').get().n,
      digests: digestRows(latestDigests(db, 5)),
      last_run: prev ? {
        id: prev.id, status: prev.status, at: prev.started_at, finished_at: prev.finished_at,
        candidates: prev.candidates, judged: prev.judged
      } : null,
      gaps,
      sources: listSources(db).map(s => ({
        id: s.id, type: s.type, url: s.url, enabled: !!s.enabled, interval_min: s.interval_min,
        ok: !s.last_error_class, error_class: s.last_error_class ?? null, cursor: getCursor(db, s.id)
      })),
      preference_errors: errors,
      schedule: pref.schedule,
      limits: pref.limits
    }
  }

  /**
   * "正在跑的一轮"以库侧状态为准：scheduler 的 busy 是私有闭包（createScheduler
   * 返回的实例上没有），而 createRun 起手就写 'running'、finishRun 才收尾——
   * lastRun 停在 'running' 正是抓取在写库的窗口，清库不与它并发。
   * 边界：runOnce 半途崩溃会留一条 'running' 假尸，下一次跑完（含手动 /run）自动
   * 愈合；这行防护挡的是并发，不是崩溃恢复。
   */
  function runningNow() {
    return lastRun(db)?.status === 'running'
  }

  async function handleApi(req, res) {
    const url = new URL(req.url ?? '/', 'http://baleen.local')
    const sub = url.pathname.startsWith(API_ROUTE) ? url.pathname.slice(API_ROUTE.length) || '/' : url.pathname
    try {
      if (sub === '/state' && req.method === 'GET') return json(res, 200, { ok: true, ...state() })
      if (sub === '/items' && req.method === 'GET') {
        const q = url.searchParams
        const opts = {
          status: q.get('status') || null, kind: q.get('kind') || null, tier: q.get('tier') || null,
          limit: num(q.get('limit'), 100, 500), offset: num(q.get('offset'), 0, 100000)
        }
        // 脏值不许原样喂给 store：Number('') === 0、Number(true) === 1，
        // 不校验就成了"筛 0 号夹（恒空）"或"筛 1 号夹"这种静默错位。边界校验归 HTTP 层。
        const folderRaw = q.get('folder')
        if (folderRaw != null && /^\d+$/.test(folderRaw)) opts.folder = Number(folderRaw)
        // 收藏页要一次拿到"这条还在哪些夹里"；其余视图沿用不带夹信息的取数，
        // 不该多背一次关系表全读。
        return json(res, 200, { ok: true, items: opts.folder == null ? listItems(db, opts) : itemsWithFolders(db, opts) })
      }
      if (sub === '/collect' && req.method === 'POST') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        // item_id 必须先自身是整数再谈别的：Number(true) === 1，先转再验会把 true
        // 收成 1 号条目——比 /feedback 的松散写法更严是 controller 拍板接受的代价。
        if (!Number.isInteger(body.item_id)) return json(res, 400, { ok: false, error: 'bad_payload' })
        const itemId = body.item_id
        const rawIds = Array.isArray(body.folder_ids) ? body.folder_ids : null
        // 元素也从严（终审 #6）：Number(true) === 1，先转换再验会把 [true] 收成"1 号夹"。
        // JSON 客户端与面板 view-api 都发数字：字符串与布尔一律响亮拒绝，不做脏转换。
        if (rawIds !== null && rawIds.some((x) => !Number.isInteger(x))) {
          return json(res, 400, { ok: false, error: 'bad_payload' })
        }
        // 走到这里元素全是整数，.map(Number) 的脏转换不再需要，NaN 也就进不了 missing。
        const wanted = rawIds
        // 只放行"有内容"的请求：folder_ids 缺席时 new_folder 必须是真名字。
        // 放过去空串就会跳过建夹、再把 wanted ?? [] 当全量替换——静默清空该条目的收藏，
        // 正是裁定 2 在 store 层堵掉的那个破坏性默认，路由层不许重新打开。
        if (wanted == null && !(typeof body.new_folder === 'string' && body.new_folder.trim())) {
          return json(res, 400, { ok: false, error: 'bad_payload' })
        }
        // 条目先于夹：收藏的动作主语是这条条目。条目都没了却报 410"夹没了"，
        // 会把面板引去修错误的那一头。
        if (!db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1').get(itemId)) {
          return json(res, 404, { ok: false, error: 'no_item' })
        }
        // 元素严格化之后这里只剩"夹存在不存在"一种检查；Set 去重保首次出现顺序，
        // 否则面板会把同一个夹 id 念两遍（终审 #7）。
        const missing = wanted === null
          ? []
          : [...new Set(wanted.filter((id) => !db.prepare('SELECT 1 FROM folders WHERE id = ? LIMIT 1').get(id)))]
        if (missing.length) {
          // 面板上一秒看的夹可能已经被另一格删掉。说清是哪几个，别静默丢掉那部分意图。
          return json(res, 410, { ok: false, error: 'folder_gone', missing })
        }
        try {
          let created = null
          // 空串当"没想起来要建"，跳过；纯空格是坏名字，交给 createFolder 报 bad_name。
          if (typeof body.new_folder === 'string' && body.new_folder.length) {
            created = createFolder(db, body.new_folder, now)
          }
          const ids = [...new Set([...(wanted ?? []), ...(created ? [created.id] : [])])]
          const resOf = setItemFolders(db, itemId, ids, now)
          log({ level: 'info', event: 'collect', detail: `item#${itemId} → ${ids.length} 个夹` })
          return json(res, 200, { ok: true, item_id: itemId, folder_ids: resOf.folder_ids, folders: listFolders(db) })
        } catch (e) {
          const msg = String(e?.message)
          // hasOwn 与 /folder 路由同理：短码撞原型键名时不能把函数当状态码用。
          // 映射用 COLLECT_ERRORS 而不是 FOLDER_ERRORS：这里 no_folder 的契约是 410。
          const code = msg === 'no_item' ? 404 : (Object.hasOwn(COLLECT_ERRORS, msg) ? COLLECT_ERRORS[msg] : 500)
          if (code === 500) log({ level: 'error', event: 'collect_failed', detail: msg.slice(0, 60) })
          return json(res, code, { ok: false, error: code === 500 ? 'internal' : msg })
        }
      }
      if (sub === '/folders' && req.method === 'GET') {
        return json(res, 200, { ok: true, folders: listFolders(db) })
      }
      if (sub === '/folder' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') || {}
        if (!FOLDER_ACTIONS.has(body.action)) return json(res, 400, { ok: false, error: 'unknown_action' })
        try {
          let folder = null
          let deleteResult = null
          if (body.action === 'create') folder = createFolder(db, body.name, now)
          else if (body.action === 'rename') folder = renameFolder(db, Number(body.id), body.name)
          else deleteResult = deleteFolder(db, Number(body.id))
          // 夹名可能带个人色彩（"考研专业课"），日志只记动作与 id。
          // id 一律取 store 的返回值：create 根本不收 body.id，rename/delete 能走到这句就说明
          // store 已按 Number(body.id) 命中过真夹。body.id 本身是客户端可控内容，不许进 detail。
          const folderId = folder?.id ?? deleteResult?.folder_id
          log({ level: 'info', event: 'folder', detail: `${body.action} #${folderId ?? ''}` })
          return json(res, 200, { ok: true, folder, folders: listFolders(db) })
        } catch (e) {
          const msg = String(e?.message)
          // hasOwn 而不是裸查表：e.message 恰好等于 toString / constructor 这类原型键名时，
          // 查表会拿到一个非数字的函数，再把它当状态码送进 writeHead。
          const code = Object.hasOwn(FOLDER_ERRORS, msg) ? FOLDER_ERRORS[msg] : 500
          if (code === 500) log({ level: 'error', event: 'folder_failed', detail: `${body.action}: ${msg.slice(0, 60)}` })
          return json(res, code, { ok: false, error: code === 500 ? 'internal' : msg })
        }
      }
      if (sub === '/run' && req.method === 'POST') {
        const r = await scheduler.triggerNow()
        return json(res, 200, { ok: !r.skipped, ...r, state: state() })
      }
      if (sub === '/feedback' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') || {}
        const actionDelta = ALLOWED_ACTIONS[body.action]
        if (actionDelta === undefined) return json(res, 400, { ok: false, error: '未知动作' })
        if (typeof body.source_id !== 'string' || !body.source_id) return json(res, 400, { ok: false, error: '缺 source_id' })
        const { pref, errors } = getPref()
        if (errors.length) return json(res, 400, { ok: false, error: 'preference_invalid', errors })
        if (!pref.sources.some((s) => s.id === body.source_id)) return json(res, 400, { ok: false, error: '源不存在' })
        // 只写 tuning.json，绝不动用户的 preference.yaml（YAML 重排会吃掉他的注释）
        const tuning = bumpTuningFile(dir, body.source_id, actionDelta)
        if (Number.isInteger(body.item_id)) markFeedback(db, body.item_id, body.action, now)
        log({ level: 'info', event: 'feedback', detail: `${body.source_id} ${body.action} → ${tuning[body.source_id] ?? 0}` })
        return json(res, 200, { ok: true, tuning, state: state() })
      }
      if (sub === '/preference' && req.method === 'GET') {
        // 设置页的读半：tuning 只读展示（loadPreference 已把 tuning.json 合并进来），写永远走 PUT 白名单
        const { pref, errors } = getPref()
        return json(res, 200, { ok: errors.length === 0, pref, errors })
      }
      if (sub === '/preference' && req.method === 'PUT') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        if (typeof body.section !== 'string' || !body.section) return json(res, 400, { ok: false, error: 'bad_payload' })
        // tuning/version 的拒绝先于白名单：这不是"没登记的节"，是产品红线（M5 全局约束）
        if (body.section === 'tuning' || body.section === 'version') return json(res, 400, { ok: false, error: 'readonly_section' })
        if (!PREF_SECTIONS.has(body.section)) return json(res, 400, { ok: false, error: 'unknown_section' })
        // value 允许合法的假值（false/0/空串/空数组），只查键在不在
        if (!('value' in body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        // 底稿必须是原文而不是 loadPreference：后者在坏文件上退默认，照它写盘一次
        // 就把用户的坏文件抹平了（与 /tuning-reset 的坏文件裁定同源）
        const raw = readPreferenceRaw(dir)
        if (raw.errors.length) return json(res, 400, { ok: false, error: 'preference_invalid', errors: raw.errors })
        const next = { ...raw.obj, [body.section]: body.value }
        // 整份校验，不过一个字不落盘——与"校验不过整轮不启动"同一哲学
        const errors = validate(next)
        if (errors.length) return json(res, 400, { ok: false, errors })
        writePreference(dir, next)
        const fresh = getPref()
        // sources 变更后镜像进表，与启动同一套写法：偏好是真源，表是运行态
        if (body.section === 'sources') syncSources(db, fresh.pref)
        // 日志只记节名：value 里是用户的主题词与源清单，一个字都不进 diagnostics
        log({ level: 'info', event: 'preference', detail: `PUT ${body.section}` })
        return json(res, 200, { ok: true, pref: fresh.pref })
      }
      if (sub === '/tuning-reset' && req.method === 'POST') {
        try {
          const cleared = clearTuningFile(dir)
          log({ level: 'info', event: 'tuning_reset', detail: `清零 ${cleared} 项` })
          return json(res, 200, { ok: true })
        } catch (e) {
          // 解析不了的文件上归零会把用户其余配置抹掉（clearTuningFile 不走默认合并）：
          // 拒绝而不是兜底。其余异常（IO）交给外层 500，别拿 400 装系统错误。
          const msg = String(e?.message ?? e)
          if (msg.startsWith('preference.yaml')) {
            return json(res, 400, { ok: false, error: 'preference_invalid', errors: [msg.slice(0, 200)] })
          }
          throw e
        }
      }
      if (sub === '/credential-status' && req.method === 'GET') {
        // 零回显红线：应答里只有存在性与 mtime，没有任何凭据内容或形态提示
        return json(res, 200, { ok: true, bili: credentialState(credFile) })
      }
      if (sub === '/credential' && req.method === 'PUT') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        // which 白名单：将来接 xhs 扫码时再扩，现在多收一个就是谎报覆盖面
        if (body.which !== 'bili') return json(res, 400, { ok: false, error: 'unknown_which' })
        // 不校验内容形态（有没有 SESSDATA 字样不关路由的事）：只拒"写不进一个字"的空值
        if (typeof body.content !== 'string' || !body.content.trim()) return json(res, 400, { ok: false, error: 'bad_payload' })
        fs.mkdirSync(path.dirname(credFile), { recursive: true })
        // 0o600 尽力而为：POSIX 上真的收紧同机其他用户可读，Windows 上 chmod 位是摆设
        fs.writeFileSync(credFile, body.content, { mode: 0o600 })
        try { fs.chmodSync(credFile, 0o600) } catch { /* 文件已落盘，权限位尽力 */ }
        // 红线：detail 只有 which 与字节数，凭据内容一个字都不进 diagnostics
        log({ level: 'info', event: 'credential', detail: `PUT bili ${Buffer.byteLength(body.content, 'utf8')} 字节` })
        return json(res, 200, { ok: true, bili: credentialState(credFile) })
      }
      if (sub === '/env-check' && req.method === 'GET') {
        // 全只读探测：node 版本、yt-dlp 版本（可空）、cookie 存在性、库大小、家目录可写
        let dbBytes = null
        try { dbBytes = fs.statSync(path.join(dir, 'baleen.sqlite')).size } catch { /* 库文件异常也不 500 */ }
        let homeWritable = true
        try { fs.accessSync(dir, fs.constants.W_OK) } catch { homeWritable = false }
        return json(res, 200, {
          ok: true,
          node: process.versions.node,
          yt_dlp: await probeYtDlp(),
          bili_cookie: credentialState(credFile).present,
          db_bytes: dbBytes,
          home_writable: homeWritable
        })
      }
      if (sub === '/diagnostics-tail' && req.method === 'GET') {
        const want = num(url.searchParams.get('lines'), 50, 200)
        let raw
        try { raw = fs.readFileSync(path.join(dir, 'logs', 'diagnostics.jsonl'), 'utf8') } catch {
          return json(res, 200, { ok: true, lines: [] })
        }
        // 逐行原样字符串再过一遍 redact：写入时已脱敏，这里双保险并罩住历史行。
        // slice(len-want) 而不是 slice(-want)：want=0 时 -0 会变成"整份"。
        const lines = raw.split(/\r?\n/).filter((l) => l.length)
        return json(res, 200, { ok: true, lines: lines.slice(Math.max(0, lines.length - want)).map(redact) })
      }
      if (sub === '/export' && req.method === 'POST') {
        const md = exportMarkdown(exportItems(db))
        const file = `baleen-export-${stampOf(now())}.md`
        fs.writeFileSync(path.join(dir, 'out', file), md, 'utf8')
        const bytes = Buffer.byteLength(md, 'utf8')
        // detail 只带字节数与文件名（文件名不含目录），路径段不进 diagnostics
        log({ level: 'info', event: 'export', detail: `${bytes} 字节 → ${file}` })
        return json(res, 200, { ok: true, file, bytes })
      }
      if (sub === '/cleanup' && req.method === 'POST') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        // days 是"清多久"的档期，不是查询参数：从严（整数且 ≥1），非法 400。
        // 不做 num() 那套"脏值走默认"——打错的天数悄悄变成默认天数，等于替用户决定删多少。
        if (!Number.isInteger(body.days) || body.days < 1) return json(res, 400, { ok: false, error: 'bad_payload' })
        if (runningNow()) return json(res, 409, { ok: false, error: 'running' })
        const backup = backupDb(db, dir, now)
        const cutoff = now() - body.days * 86400000
        // 只清归档：清理是磁盘卫生不是记忆删除，new/judged 一条不动（计划 Task 3 裁定）
        const removed = db.prepare("DELETE FROM items WHERE status = 'archived' AND fetched_at < ?").run(cutoff).changes
        log({ level: 'info', event: 'cleanup', detail: `${body.days} 天：删 ${removed} 条归档` })
        return json(res, 200, { ok: true, removed, backup })
      }
      if (sub === '/wipe' && req.method === 'POST') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        // 字面量门在一切副作用之前：不是这个字就 400，备份也不做（备份也是一次磁盘写入）。
        // 严格相等，'清空库 '（带空格）不算——确认词必须是无歧义的原样输入。
        if (body.confirm !== '清空库') return json(res, 400, { ok: false, error: 'confirm_required' })
        if (runningNow()) return json(res, 409, { ok: false, error: 'running' })
        const backup = backupDb(db, dir, now)
        const removed = wipeLibrary(db)
        log({ level: 'info', event: 'wipe', detail: `清空：items ${removed.items} · runs ${removed.runs} · digests ${removed.digests}` })
        return json(res, 200, { ok: true, removed, backup })
      }
      return json(res, 404, { ok: false, error: 'no such route' })
    } catch (e) {
      log({ level: 'error', event: 'route_failed', detail: String(e?.message ?? e).slice(0, 200) })
      return json(res, 500, { ok: false, error: 'internal' })
    }
  }

  const baleen = {
    state,
    folders: () => listFolders(db),
    list: (opts) => listItems(db, opts),
    // 服务入口不代劳建夹：/collect 路由自己先 createFolder 再 setItemFolders，
    // 别的插件要用服务入口就自己先建夹——少一个参数就少一条"谁负责校验"的路径。
    // 注意 folders() 返回裸数组，与 HTTP 路由的 {ok, folders} 信封不同（与 list 同形）。
    collect: (itemId, folderIds) => setItemFolders(db, itemId, folderIds, now),
    foldersOf: (itemId) => foldersOfItem(db, itemId),
    runNow: () => scheduler.triggerNow(),
    tick: () => scheduler.tick(),
    db,
    dir,
    prefs
  }

  const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : null) ?? ctx.webServer ?? null
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: API_ROUTE, handler: (req, res) => handleApi(req, res) }),
      'dsh-baleen: api'
    )
  } else {
    log({ level: 'error', event: 'no_webserver', detail: '拿不到 webServer，面板将无法读写数据' })
  }

  // 工具面与注入：挂法照抄本机 dsh-mneme 在**当前宿主**上的实测形态（src/index.js:554/563、
  // src/tools.js:1058、src/inject.js:345-354）——`ctx.inject([服务名], 回调)` 等服务就绪，
  // 工具走 `toolsCtx.tools.register`，注入走 `promptCtx.systemPrompt.context({ text: 回调 })`
  // 每轮现渲染（study-desk 的 `ctx.on('system-prompt/assemble')` 是旧版宿主的事件，10 月更新后已不存在）。
  // 服务缺席（headless / 宿主裁剪）时回调不会被调，判断轮没有入口，但摄取与面板照常，绝不炸启动。
  ctx.inject(['tools'], (toolsCtx) => {
    try {
      const tools = toolsCtx?.tools ?? ctx.tools ?? null
      if (!tools || typeof tools.register !== 'function') {
        log({
          level: 'warn',
          event: 'no_tools',
          detail: tools
            ? `tools 缺 register 方法，keys=[${Object.keys(tools).join(',')}]`
            : '拿不到 tools，判断轮没有工具面（摄取与面板不受影响）'
        })
        return
      }
      for (const t of baleenTools({ db, getPref, now, fetchImpl: config.fetchImpl, spawnImpl: config.spawnImpl })) {
        try {
          tools.register(t)
          log({ level: 'info', event: 'tool_registered', detail: t.name })
        } catch (e) {
          log({ level: 'error', event: 'tool_register_failed', detail: `${t.name}: ${String(e?.message ?? e).slice(0, 120)}` })
        }
      }
    } catch (e) {
      log({ level: 'error', event: 'tools_inject_failed', detail: String(e?.message ?? e).slice(0, 120) })
    }
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      if (typeof promptCtx?.systemPrompt?.context !== 'function') {
        log({ level: 'warn', event: 'no_systemprompt_context', detail: '宿主没有 systemPrompt.context seam，待判注入段不挂' })
        return
      }
      // 每轮渲染：开关与静默条件在回调里现读（改 preference.yaml 立即生效），
      // 空串不占位——候选 0 且无失败源时宿主拿到的就是空段。零正文零 URL：文本只出自
      // pendingSectionText（计数 + 标题截断 + 工具名），见 Task 3 的红线断言。
      promptCtx.systemPrompt.context({
        name: 'dsh-baleen:pending',
        order: 90,
        text: () => {
          try {
            if (getPref().pref.inject_prompt === false) return ''
            return pendingSectionText(db)
          } catch { return '' }
        }
      })
      log({ level: 'info', event: 'pending_section_mounted', detail: 'baleen-pending 注入段已挂' })
    } catch (e) {
      log({ level: 'error', event: 'inject_mount_failed', detail: String(e?.message ?? e).slice(0, 120) })
    }
  })

  ctx.effect(
    () => ctx.provide('baleen', baleen),
    'dsh-baleen: service'
  )

  // start() 返回 handle，effect 的返回函数会被当作 dispose——禁用插件时定时器跟着停，
  // 不会留下一个还在偷偷抓取的 interval。
  ctx.effect(() => {
    const handle = scheduler.start()
    return () => scheduler.stop(handle)
  }, 'dsh-baleen: scheduler')

  log({ level: 'info', event: 'plugin_loaded', detail: `M1 摄取侧就绪（只读路由 ${API_ROUTE}）` })
  return baleen
}
