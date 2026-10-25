import fs from 'node:fs'
import path from 'node:path'
import { openStore, migrate, counts, listItems, listSources, lastRun, getCursor, markFeedback, listFolders, createFolder, renameFolder, deleteFolder, setItemFolders, foldersOfItem, itemsWithFolders, candidates } from './lib/store.js'
import { loadPreference, ensurePreferenceFile, bumpTuningFile } from './lib/preference.js'
import { runOnce, syncSources } from './lib/runner.js'
import { createScheduler } from './lib/scheduler.js'
import { makeLogger } from './lib/diag.js'
import { ensureHome } from './lib/paths.js'
import { baleenTools } from './lib/tools.js'

export const name = 'dsh-baleen'
// 'tools' 是判断轮的入口：inject 声明过，宿主才会等 tools 服务激活后再 apply 本插件
export const inject = ['tools', 'webServer']

const API_ROUTE = '/api/dsh-baleen'

/** 面板两个按钮允许的动作，与客户端白名单一致；值就是对来源权重的增量 */
const ALLOWED_ACTIONS = { dismiss: -0.1, save: 0.1 }

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
  segs.push('可用工具：baleen.candidates / read_item / save_verdicts')
  return `Baleen：${segs.join('。')}。`
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

  function state() {
    const { pref, errors } = getPref()
    const prev = lastRun(db)
    let gaps = null
    try { gaps = prev?.gaps_json ? JSON.parse(prev.gaps_json) : null } catch { gaps = null }
    return {
      home: '<HOME>',
      counts: counts(db),
      digest_count: db.prepare('SELECT COUNT(*) n FROM digests').get().n,
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

  // 工具面：注册写法同款抄 dsh-study-desk（tools.register 包 ctx.effect，禁用时宿主按条回收）。
  // tools 缺席（headless / 宿主裁剪）就降级成无工具——判断轮没有入口，但摄取与面板照常，绝不炸启动。
  const tools = (typeof ctx.get === 'function' ? ctx.get('tools') : null) ?? ctx.tools ?? null
  if (tools && typeof tools.register === 'function') {
    for (const t of baleenTools({ db, getPref, now })) {
      ctx.effect(() => tools.register(t), `baleen: tool ${t.name}`)
    }
  } else {
    log({ level: 'warn', event: 'no_tools', detail: '拿不到 tools，判断轮没有工具面（摄取与面板不受影响）' })
  }

  // 判断轮的触发器：挂法照抄本机 dsh-study-desk 的实测形态（裸 ctx.on，不进 ctx.effect——
  // 插件禁用时宿主随上下文一起回收监听）。先 await next() 拿下游装配结果，再把段落 push 进去；
  // 开关在钩子内现读，改 preference.yaml 立即生效。注入失败静默吞掉，不影响对话本身。
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    try {
      if (getPref().pref.inject_prompt === false) return assembled
      const text = pendingSectionText(db)
      if (text) assembled.sections?.push?.({ name: 'dsh-baleen:pending', text })
    } catch { /* 注入失败不影响对话 */ }
    return assembled
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
