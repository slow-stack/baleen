import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-host-'))

function fakeRes() {
  return {
    code: 0, headers: null, body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(s) { this.body = s }
  }
}

function makeCtx(home, { withServer = true, timers = [] } = {}) {
  const provided = new Map()
  const effects = []
  const disposes = []
  const registered = []
  const webServer = withServer ? { register: (def) => { registered.push(def); return () => { def.__disposed = true } } } : undefined
  const logs = []
  process.env.BALEEN_HOME = home
  return {
    registered, provided, effects, disposes, logs, timers,
    get: (n) => (n === 'webServer' ? webServer : undefined),
    webServer,
    provide: (n, v) => provided.set(n, v),
    effect: (fn, label) => {
      const d = fn()
      effects.push(label)
      if (typeof d === 'function') disposes.push(d)
    },
    setInterval: (fn, ms) => { timers.push({ kind: 'set', ms }); return { id: timers.length } },
    clearInterval: (h) => { timers.push({ kind: 'clear', h }) },
  }
}

test('宿主半导出形状固定', async () => {
  const host = await import('../index.js')
  assert.equal(host.name, 'dsh-baleen')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('apply 建好家目录、库与偏好文件，并注册服务与前缀路由', async () => {
  const home = freshHome()
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  assert.ok(fs.existsSync(path.join(home, 'baleen.sqlite')), '库没落在指定家目录')
  assert.ok(fs.existsSync(path.join(home, 'preference.yaml')), '偏好模板没生成')
  assert.ok(fs.existsSync(path.join(home, 'out')), 'ensureHome 没建 out/')
  assert.equal(ctx.provided.get('baleen'), baleen)
  assert.deepEqual(ctx.registered.map(r => r.path), ['/api/dsh-baleen'])
  assert.equal(ctx.registered[0].kind, 'prefix')
  assert.deepEqual(ctx.effects, ['dsh-baleen: api', 'dsh-baleen: service', 'dsh-baleen: scheduler'])
})

test('GET /state 返回可渲染的状态，家目录写成占位符', async () => {
  const home = freshHome()
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const res = fakeRes()
  await ctx.registered[0].handler({ url: '/api/dsh-baleen/state', method: 'GET' }, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.home, '<HOME>')
  assert.deepEqual(body.counts, { new: 0, judged: 0, digest: 0, archived: 0, total: 0 })
  assert.deepEqual(body.sources, [])
  assert.deepEqual(body.preference_errors, [])
  assert.equal(body.last_run, null)
})

test('GET /items 消毒查询参数；未知路由 404；不把宿主拖崩', async () => {
  const home = freshHome()
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const h = ctx.registered[0].handler
  const r1 = fakeRes()
  await h({ url: '/api/dsh-baleen/items?limit=7', method: 'GET' }, r1)
  assert.equal(r1.code, 200)
  assert.deepEqual(JSON.parse(r1.body).items, [])
  const rAbc = fakeRes()
  await h({ url: '/api/dsh-baleen/items?limit=abc&offset=-5', method: 'GET' }, rAbc)
  assert.equal(rAbc.code, 200)                                    // 参数写坏按默认值走，不是 500
  assert.deepEqual(JSON.parse(rAbc.body).items, [])
  const r2 = fakeRes()
  await h({ url: '/api/dsh-baleen/nope', method: 'GET' }, r2)
  assert.equal(r2.code, 404)
  const r3 = fakeRes()
  await h({ url: null, method: 'GET' }, r3)   // 畸形请求也走"没有这条路由"，不抛
  assert.equal(r3.code, 404)
})

test('POST /run 走一次调度；没有源时也是 done，且没有网络请求', async () => {
  const home = freshHome()
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const res = fakeRes()
  await ctx.registered[0].handler({ url: '/api/dsh-baleen/run', method: 'POST' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.skipped, false)
  assert.equal(body.status, 'done')
  assert.equal(body.state.last_run.status, 'done')
})

test('拿不到 webServer 时不抛，只记一条错误日志', async () => {
  const home = freshHome()
  const ctx = makeCtx(home, { withServer: false })
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  assert.equal(ctx.registered.length, 0)
  const logFile = path.join(home, 'logs', 'diagnostics.jsonl')
  assert.match(fs.readFileSync(logFile, 'utf8'), /no_webserver/)
  assert.equal(baleen.state().home, '<HOME>')
})

test('effect 的 dispose 会清掉定时器（禁用插件后不再偷偷抓取）', async () => {
  const home = freshHome()
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, tickMin: 2, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  assert.deepEqual(ctx.timers.filter(t => t.kind === 'set').map(t => t.ms), [120000])
  for (const d of ctx.disposes) d()
  assert.equal(ctx.timers.filter(t => t.kind === 'clear').length, 1)
})

test('启动就把偏好里的源镜像进表（不用等第一轮跑完）', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'), [
    'version: 1',
    'sources:',
    '  - id: blog-a',
    '    type: rss',
    '    url: https://example.com/feed',
    '    interval_min: 720',
    '    weight: 0.8',
    ''
  ].join('\n'))
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const s = baleen.state()
  assert.deepEqual(s.sources.map(x => x.id), ['blog-a'])
  assert.equal(s.sources[0].interval_min, 720)
  assert.equal(s.sources[0].cursor, null)
})

test('tick 在窗外不抓取；runNow 无视窗', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'),
    'version: 1\nsources: []\nschedule:\n  windows: ["03:00-03:01"]\n  max_per_run: 5\n')
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  assert.deepEqual(baleen.tick(), { skipped: true, why: 'window' })
  const r = await baleen.runNow()
  assert.equal(r.skipped, false)
})
