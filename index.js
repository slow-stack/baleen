import fs from 'node:fs'
import path from 'node:path'
import { openStore, migrate, counts, listItems, listSources, lastRun, getCursor, markFeedback } from './lib/store.js'
import { loadPreference, ensurePreferenceFile, bumpTuningFile } from './lib/preference.js'
import { runOnce, syncSources } from './lib/runner.js'
import { createScheduler } from './lib/scheduler.js'
import { makeLogger } from './lib/diag.js'
import { ensureHome } from './lib/paths.js'

export const name = 'dsh-baleen'
export const inject = ['webServer']

const API_ROUTE = '/api/dsh-baleen'

/** 面板两个按钮允许的动作，与客户端白名单一致；值就是对来源权重的增量 */
const ALLOWED_ACTIONS = { dismiss: -0.1, save: 0.1 }

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

/** 查询参数一律消毒：`?limit=abc` 应该按默认值走，而不是把路由打成 500。 */
function num(v, dflt, max) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? Math.min(max, n) : dflt
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
    return {
      home: '<HOME>',
      counts: counts(db),
      last_run: prev ? {
        id: prev.id, status: prev.status, at: prev.started_at, finished_at: prev.finished_at,
        candidates: prev.candidates, judged: prev.judged
      } : null,
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
        return json(res, 200, {
          ok: true,
          items: listItems(db, {
            status: q.get('status') || null, kind: q.get('kind') || null, tier: q.get('tier') || null,
            limit: num(q.get('limit'), 100, 500), offset: num(q.get('offset'), 0, 100000)
          })
        })
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
    list: (opts) => listItems(db, opts),
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
