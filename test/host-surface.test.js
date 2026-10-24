import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setItemFolders } from '../lib/store.js'

// 测试自清（终审 #21）：家目录登记进 homes；makeCtx 的 provide 顺手记下每次 apply 开出的
// 库句柄——Windows 上 node:sqlite 句柄不关，rmSync 会 EPERM，所以收尾先关库再删目录。
// 断言都在测试体内读目录，after 晚于它们跑，没有断言还要回头读这里。
const homes = []
const dbs = []
const freshHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-host-'))
  homes.push(d)
  return d
}
after(() => {
  for (const db of dbs) db.close()
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

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
    provide: (n, v) => { provided.set(n, v); if (n === 'baleen' && v && v.db) dbs.push(v.db) },
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

// 终审 #11 的防回退钉子：既有 /items 测试全是空库断言 []，limit 的语义根本没被罩住。
// num() 现状即正确（缺席走默认 100，limit=0 明确取空），这两条首发即绿，钉住别退。
test('GET /items 不带 limit 时非空：缺席走默认值，不是被 Number(null) 收成 0', async () => {
  const { h, baleen } = await apiOf(freshHome())
  seedItem(baleen, { external_id: 'a' })
  seedItem(baleen, { external_id: 'b' })
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/items', method: 'GET' }, res)
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).items.length, 2, '不带 limit 拿到空列表，列表页就成了白纸')
})

test('GET /items?limit=0 明确取空：0 是合法的限量值，不是被当成缺席', async () => {
  const { h, baleen } = await apiOf(freshHome())
  seedItem(baleen)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/items?limit=0', method: 'GET' }, res)
  assert.equal(res.code, 200)
  assert.deepEqual(JSON.parse(res.body).items, [])
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
  setItemFolders(baleen.db, iid, [fid])
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 1, '收藏关系没建起来，下面那句 folder_items == 0 就是永真')
  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: fid }) }, del)
  assert.equal(del.code, 200)
  assert.equal(JSON.parse(del.body).folders.length, 1)
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1, '删夹把条目删了')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
})

test('folder 事件进日志时只有动作与夹 id，不含夹名也不含标题', async () => {
  const home = freshHome()
  const { h } = await apiOf(home)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '考研专业课' }) }, res)
  // 本仓日志固定落 <home>/logs/diagnostics.jsonl（lib/diag.js 的 makeLogger），不是 <home>/*.log
  const logFile = path.join(home, 'logs', 'diagnostics.jsonl')
  const blob = fs.readFileSync(logFile, 'utf8')
  // 钉死事件名：只匹配 "folder" 子串的话，一个只写 folder_failed 的实现也能过
  assert.match(blob, /"event":"folder"/, '建夹没记日志')
  assert.doesNotMatch(blob, /考研专业课/, '日志里出现了夹名')
})

test('把夹名塞进 id 字段建夹：照样 200，但日志里只许出现 store 给的夹 id', async () => {
  const home = freshHome()
  const { h } = await apiOf(home)
  const res = fakeRes()
  // create 分支从不读 body.id（lib/store.js 的 createFolder 只有 db/raw/now 三个参数），
  // 所以这个字段是纯客户端可控内容：它进了 detail 就是把夹名写进了 diagnostics.jsonl。
  await h({
    url: '/api/dsh-baleen/folder', method: 'POST',
    ...bodyOf({ action: 'create', name: '考研专业课', id: '考研专业课' })
  }, res)
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).folder.name, '考研专业课')
  const blob = fs.readFileSync(path.join(home, 'logs', 'diagnostics.jsonl'), 'utf8')
  assert.match(blob, /"event":"folder"/, '建夹没记日志')
  assert.doesNotMatch(blob, /考研专业课/, '客户端可控的 id 字段被原样写进了日志')
  assert.match(blob, /"detail":"create #2"/, 'detail 里该是 store 返回的夹 id（默认夹占 1，新建的是 2）')
})

const seedItem = (baleen, over = {}) => {
  baleen.db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, body_state, fetched_at, status)
    VALUES ('s1', @external_id, 'article', 't', 'https://e.com/x', 'full', 1000, 'new')`)
    .run({ external_id: over.external_id ?? 'e1' })
  return baleen.db.prepare('SELECT id FROM items ORDER BY id DESC LIMIT 1').get().id
}

test('POST /collect 是全量替换，重复提交同一集合结果不变', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '一' }) }, mk)
  const oneId = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  const r1 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [oneId] }) }, r1)
  assert.equal(r1.code, 200)
  assert.deepEqual(JSON.parse(r1.body).folder_ids, [oneId])
  const r2 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [oneId, oneId] }) }, r2)
  assert.deepEqual(JSON.parse(r2.body).folder_ids, [oneId], '重复 id 没去重')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 1)
})

test('/collect 的 new_folder 与收藏在同一次请求里做完，不留空夹', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const iid = seedItem(baleen)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [], new_folder: '新起的' }) }, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  const created = body.folders.find((f) => f.name === '新起的')
  assert.ok(created, '夹没建成')
  assert.deepEqual(body.folder_ids, [created.id], '夹建好了但条目没进去')
})

test('/collect 的失败路径：夹没了、条目没了、载荷坏了各说各话', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '二' }) }, mk)
  const goneId = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  // 先删掉它，goneId 才真的是"没了的夹"：下面 410 报的 missing 里才有它。
  // 简报把这一步 delete 写在 r5 之前才执行，可那样 r1 时 goneId 还活着，missing 永远凑不出 [goneId, 999]。
  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: goneId }) }, del)
  assert.equal(del.code, 200, '前置删除没成功，goneId 不是"没了的夹"')
  const r1 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [goneId, 999] }) }, r1)
  assert.equal(r1.code, 410)
  assert.deepEqual(JSON.parse(r1.body).missing, [goneId, 999])
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '失败的那次写出了半套关系')

  const r2 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: 99999, folder_ids: [goneId] }) }, r2)
  assert.equal(r2.code, 404)
  assert.equal(JSON.parse(r2.body).error, 'no_item')

  const r3 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid }) }, r3)
  assert.equal(r3.code, 400)
  assert.equal(JSON.parse(r3.body).error, 'bad_payload')

  const r4 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf('坏掉的') }, r4)
  assert.equal(r4.code, 400)

  const r5 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [], new_folder: '  ' }) }, r5)
  assert.equal(r5.code, 400)
  assert.equal(JSON.parse(r5.body).error, 'bad_name')
})

// 终审 #7：missing 是要回显给面板"哪些夹没了"的清单，同一 id 写两遍就念两遍。
// 去重保首次出现顺序；既有断言 missing: [goneId, 999] 的语义不变。
test('/collect 的 missing 去重：同一夹 id 重复出现只报一次，保首次出现顺序', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '五' }) }, mk)
  const goneId = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: goneId }) }, del)
  assert.equal(del.code, 200, '前置删除没成功，goneId 不是"没了的夹"')
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [goneId, goneId, 999] }) }, res)
  assert.equal(res.code, 410)
  assert.deepEqual(JSON.parse(res.body).missing, [goneId, 999], '重复的夹 id 原样带出，面板会念两遍')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '失败的那次写出了半套关系')
})

test('/collect 没带 folder_ids、new_folder 又是空串：400，不清空已有收藏', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const iid = seedItem(baleen)
  const seed = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [1] }) }, seed)
  assert.equal(seed.code, 200, '前置收藏没建起来')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items WHERE item_id = ?').get(iid).n, 1)
  // 空串 new_folder 不是"要建夹"，folder_ids 缺席也不是"清空"。这种没内容的请求必须响：
  // 放过去就是 wanted ?? [] 全量替换——静默抹掉该条目的全部收藏。
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, new_folder: '' }) }, res)
  assert.equal(res.code, 400)
  assert.equal(JSON.parse(res.body).error, 'bad_payload')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items WHERE item_id = ?').get(iid).n, 1, '坏请求把收藏清空了')
})

test('/collect 的 item_id 要整数：true 不再被 Number 收成 1 号条目', async () => {
  const { h, baleen } = await apiOf(freshHome())
  seedItem(baleen) // 1 号条目：Number(true) === 1 泄漏时收藏被写到的就是它
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: true, folder_ids: [1] }) }, res)
  assert.equal(res.code, 400)
  assert.equal(JSON.parse(res.body).error, 'bad_payload')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, 'true 被当成 1 号条目写进了收藏')
})

// 终审 #6：folder_ids 的元素此前仍走 .map(Number)，[true] 会被收成"1 号夹"。
// JSON 客户端与面板 view-api 都发数字，字符串与布尔一律响亮拒绝，不做脏转换。
test('/collect 的 folder_ids 元素要整数：true 与字符串 id 一律响亮拒绝', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const iid = seedItem(baleen)
  for (const bad of [[true], ['1']]) {
    const res = fakeRes()
    await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: bad }) }, res)
    assert.equal(res.code, 400, JSON.stringify(bad))
    assert.equal(JSON.parse(res.body).error, 'bad_payload', JSON.stringify(bad))
  }
  // Number(true) === 1、Number('1') === 1：默认夹恰好是 1 号，脏转换放行就是静默收进默认夹
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '脏元素被 Number 收成了真夹写进收藏')
})

test('GET /items?folder= 取该夹条目并带上所属夹，归档的也列得出', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '三' }) }, mk)
  const fid = JSON.parse(mk.body).folder.id
  const keep = seedItem(baleen, { external_id: 'keep' })
  const other = seedItem(baleen, { external_id: 'other' })
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: keep, folder_ids: [fid] }) }, fakeRes())
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: other, folder_ids: [fid] }) }, fakeRes())
  baleen.db.prepare("UPDATE items SET status='archived', archived_reason='stale:20 天前' WHERE id=?").run(other)
  const res = fakeRes()
  await h({ url: `/api/dsh-baleen/items?folder=${fid}`, method: 'GET' }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.code, 200)
  assert.equal(body.items.length, 2, '归档的条目从收藏页消失了')
  assert.deepEqual(body.items.map((i) => i.folders).sort(), [[fid], [fid]])
  assert.deepEqual(body.items[0].folder_names, ['三'])
})

test('/items?folder= 的应答真的带收藏时间：added_at 来自 folder_items 的投影，不是视图自造', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '收过' }) }, mk)
  const fid = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  const c = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [fid] }) }, c)
  assert.equal(c.code, 200, '前置收藏没建起来')
  // 把关系时间改成与 fetched_at(1000) 不同的值：added_at 若是从条目列"顺手抄来"的，这里就露馅
  baleen.db.prepare('UPDATE folder_items SET added_at = 4321 WHERE item_id = ?').run(iid)
  const res = fakeRes()
  await h({ url: `/api/dsh-baleen/items?folder=${fid}`, method: 'GET' }, res)
  const body = JSON.parse(res.body)
  const item = body.items.find((i) => i.id === iid)
  assert.ok(item, '条目没在这一夹的应答里')
  assert.equal(typeof item.added_at, 'number', '视图读 item.added_at；取数路径不投影这个字段，每张卡都只能显示（时间未知）')
  assert.equal(item.added_at, 4321, '收藏时间必须是 folder_items.added_at 本身，不是任何条目列的化名')
})

test('/items 的脏 folder 参数当没带，不把 Number 的脏转换喂给 store', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '四' }) }, mk)
  const fid = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [fid] }) }, fakeRes())
  // 1 号是默认夹：往里再放一条。folder 若被 Number(true) 之类的脏收成 1，列表会从
  // "全量"缩成这一条——下面的脏值迭代这才真抓得到泄漏，而不是只靠 store 的兜底。
  const inDefault = seedItem(baleen, { external_id: 'def' })
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: inDefault, folder_ids: [1] }) }, fakeRes())
  const one = fakeRes()
  await h({ url: '/api/dsh-baleen/items?folder=1', method: 'GET' }, one)
  assert.equal(one.code, 200)
  assert.deepEqual(JSON.parse(one.body).items.map((i) => i.id), [inDefault], 'folder=1 的正路过滤本身不对')
  // Number('') === 0、Number(true) === 1：脏值不校验就进 store，'' 会变成"筛 0 号夹"（恒空）、
  // 'true' 会变成"筛 1 号夹"。脏值必须当这个参数不存在——视图与不带 folder 时一致。
  for (const dirty of ['', 'true', '-1', '1.5', 'abc']) {
    const res = fakeRes()
    await h({ url: `/api/dsh-baleen/items?folder=${encodeURIComponent(dirty)}`, method: 'GET' }, res)
    assert.equal(res.code, 200, dirty)
    assert.equal(JSON.parse(res.body).items.length, 2, `脏值 folder=${dirty} 被当成了过滤条件`)
  }
})

test('collect 不注册成 agent 工具：宿主半的 inject 仍然只有 webServer', async () => {
  const host = await import('../index.js')
  assert.deepEqual(host.inject, ['webServer'])
})
