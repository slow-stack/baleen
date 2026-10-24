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

/** 假请求直接给 rawBody，不 mock EventEmitter（readBody 两种都吃） */
const bodyOf = (o) => ({ rawBody: JSON.stringify(o) })

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
  assert.equal(body.digest_count, 0)
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
  assert.equal(body.state.gaps.total_dropped, 0)     // gaps 必须落库并回传，「今天」靠它写诚实的那行
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

test('POST /feedback 只改 tuning，themes 与 sources 原样不动', async () => {
  const home = freshHome()
  const yaml = [
    'version: 1',
    'themes:',
    '  - group: AI',
    '    any: [MCP]',
    '    weight: 1.0',
    'sources:',
    '  - id: blog-a',
    '    type: rss',
    '    url: https://example.com/feed',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(home, 'preference.yaml'), yaml)
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const res = fakeRes()
  await ctx.registered[0].handler(
    { url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf({ source_id: 'blog-a', action: 'dismiss' }) }, res)
  assert.equal(res.code, 200)
  const out = JSON.parse(res.body)
  assert.deepEqual(out.tuning, { 'blog-a': -0.1 })
  // 用户的 yaml 必须一字未动：YAML 重排会吃掉注释，那两个按钮没资格改他的文件
  assert.equal(fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8'), yaml)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'tuning.json'), 'utf8')), { 'blog-a': -0.1 })
  // 再点一次是累加，限幅由 bumpTuningFile 管
  const r2 = fakeRes()
  await ctx.registered[0].handler({ url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf({ source_id: 'blog-a', action: 'dismiss' }) }, r2)
  assert.deepEqual(JSON.parse(r2.body).tuning, { 'blog-a': -0.2 })
})

test('feedback 的未知动作、缺 source_id、不存在的源都被拒且不写文件', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'), 'version: 1\nsources:\n  - id: real\n    type: rss\n    url: https://e.com/f\n')
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  const before = fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8')
  const h = ctx.registered[0].handler
  for (const body of [{ source_id: 'real', action: 'like' }, { action: 'save' }, { source_id: 'ghost', action: 'save' }]) {
    const r = fakeRes()
    await h({ url: '/api/dsh-baleen/feedback', method: 'POST', ...bodyOf(body) }, r)
    assert.equal(r.code, 400, JSON.stringify(body))
    assert.equal(JSON.parse(r.body).ok, false)
  }
  assert.equal(fs.readFileSync(path.join(home, 'preference.yaml'), 'utf8'), before, '被拒的反馈不该动文件')
  assert.equal(fs.existsSync(path.join(home, 'tuning.json')), false, '被拒的反馈也不该写 tuning.json')
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

const apiOf = async (home) => {
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  return { h: ctx.registered[0].handler, baleen, ctx }
}

test('GET /folders 至少带回那个删不掉的默认夹', async () => {
  const { h } = await apiOf(freshHome())
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folders', method: 'GET' }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.code, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.folders, [{ id: 1, name: '默认', is_default: 1, count: 0 }])
})

test('POST /folder 建夹：成功就回整个列表', async () => {
  const { h } = await apiOf(freshHome())
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '公共管理' }) }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.code, 200)
  assert.equal(body.folder.name, '公共管理')
  assert.equal(body.folder.is_default, 0)
  assert.deepEqual(body.folders.map(f => f.name), ['默认', '公共管理'])
})

test('建夹的失败路径给的是人话状态码，不是 500', async () => {
  const { h } = await apiOf(freshHome())
  const cases = [
    [{ action: 'create', name: '  ' }, 400, 'bad_name'],
    [{ action: 'create', name: 'x'.repeat(41) }, 400, 'name_too_long'],
    [{ action: 'create', name: '默认' }, 409, 'name_taken'],
    [{ action: 'nope' }, 400, 'unknown_action'],
    [{ action: 'delete', id: 1 }, 403, 'default_folder'],
    [{ action: 'delete', id: 999 }, 404, 'no_folder'],
    [{ action: 'rename', id: 999, name: 'x' }, 404, 'no_folder'],
    [{}, 400, 'unknown_action'],
    [{ action: 'create' }, 400, 'bad_name']
  ]
  for (const [payload, code, error] of cases) {
    const res = fakeRes()
    await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf(payload) }, res)
    assert.equal(res.code, code, JSON.stringify(payload) + ' 的状态码不对')
    assert.equal(JSON.parse(res.body).error, error, JSON.stringify(payload))
    assert.equal(JSON.parse(res.body).ok, false)
  }
})

test('删自建夹：条目一条不少，夹列表变短', async () => {
  const home = freshHome()
  const { h, baleen } = await apiOf(home)
  const created = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '要精读' }) }, created)
  const fid = JSON.parse(created.body).folder.id
  baleen.db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, body_state, fetched_at, status)
    VALUES ('s1', 'e1', 'article', 't', 'https://e.com/1', 'full', 1000, 'new')`).run()
  const iid = baleen.db.prepare('SELECT id FROM items').get().id
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [fid] }) }, fakeRes())
  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: fid }) }, del)
  assert.equal(del.code, 200)
  assert.equal(JSON.parse(del.body).folders.length, 1)
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1, '删夹把条目删了')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
})

test('folder 事件进日志时只有动作与夹 id，不含夹名也不含标题', async () => {
  const home = freshHome()
  process.env.BALEEN_HOME = home
  const { h } = await apiOf(home)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '考研专业课' }) }, res)
  // 本仓日志固定落 <home>/logs/diagnostics.jsonl（lib/diag.js 的 makeLogger），不是 <home>/*.log
  const logFile = path.join(home, 'logs', 'diagnostics.jsonl')
  const blob = fs.readFileSync(logFile, 'utf8')
  assert.match(blob, /folder/, '建夹没记日志')
  assert.doesNotMatch(blob, /考研专业课/, '日志里出现了夹名')
})
