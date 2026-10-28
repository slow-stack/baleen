import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDefineTool } from '../lib/tools.js'
import { createRun, finishRun } from '../lib/store.js'

// 工具面红线测试。注册清单恰好六个（M4a 起含 baleen_subtitle）、save_verdicts 唯一写且三档枚举锁死、
// 平台写动词在工具面零出现——这些条在任何后续改动中红了就是事故。
// ctx 桩手法同 test/host-surface.test.js 的 makeCtx，同款加了 tools 服务。

const homes = []
const dbs = []
const freshHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-tools-'))
  homes.push(d)
  return d
}
after(() => {
  for (const db of dbs) db.close()
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

function makeCtx(home, { withTools = true } = {}) {
  const provided = new Map()
  const effects = []
  const disposes = []
  const registered = []
  const toolRegistry = []
  // M3 起工具注册走 ctx.inject(['tools'], callback)（dsh-mneme 在当前宿主的实测形态）：
  // 这里记录 inject 声明，注册行为在测试里手动触发回调后断言。
  const injects = []
  const webServer = { register: (def) => { registered.push(def); return () => { def.__disposed = true } } }
  const tools = withTools ? { register: (t) => { toolRegistry.push(t); return () => {} } } : undefined
  process.env.BALEEN_HOME = home
  return {
    registered, provided, effects, disposes, toolRegistry, injects,
    get: (n) => (n === 'webServer' ? webServer : n === 'tools' ? tools : undefined),
    on: (ev, fn) => {},
    inject: (services, callback) => { injects.push({ services, callback }) },
    webServer,
    tools,
    provide: (n, v) => { provided.set(n, v); if (n === 'baleen' && v && v.db) dbs.push(v.db) },
    effect: (fn, label) => {
      const d = fn()
      effects.push(label)
      if (typeof d === 'function') disposes.push(d)
    },
    setInterval: (fn, ms) => ({ id: 1, ms }),
    clearInterval: () => {},
  }
}

/** 手动触发工具面注入回调：与宿主"服务就绪后调 callback"同构。 */
const fireToolsInject = (ctx) => {
  const inj = ctx.injects.find((i) => i.services.includes('tools'))
  if (!inj) throw new Error('apply 没有声明 ctx.inject(["tools"], ...) —— 工具面没挂')
  inj.callback({ tools: ctx.tools })
}

const applyOf = async (home, opts = {}) => {
  const ctx = makeCtx(home, opts)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, {
    now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval,
    // config 透传（如 fetchImpl）：subtitle 工具现取字幕时用它注入 bili fetch 桩
    ...(opts.config ?? {}),
  })
  return { ctx, baleen }
}

const toolOf = (ctx, name) => ctx.toolRegistry.find((t) => t.name === name)

const seedItem = (db, over = {}) => {
  db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, author, body_text, body_state, match_json,
    prefilter_score, fetched_at, published_at, status)
    VALUES ('s1', @external_id, @kind, @title, @url, @author, @body_text, @body_state, @match_json,
    @prefilter_score, 1000, 900, @status)`)
    .run({
      external_id: 'e1', kind: 'article', title: 't', url: 'https://e.com/1', author: '谁',
      body_text: '正文', body_state: 'full', match_json: '{"group":"AI","hit":["MCP"]}',
      prefilter_score: 3, status: 'new', ...over,
    })
  return db.prepare('SELECT id FROM items ORDER BY id DESC LIMIT 1').get().id
}

/* ---------------- 红线：清单与 schema ---------------- */

test('注册清单恰好 6 个，名字与 spec §10.1 逐字一致', async () => {
  const { ctx } = await applyOf(freshHome())
  fireToolsInject(ctx)
  assert.deepEqual(ctx.toolRegistry.map((t) => t.name), [
    'baleen_query', 'baleen_read_item', 'baleen_candidates', 'baleen_run_status', 'baleen_subtitle', 'baleen_save_verdicts',
  ])
  // inject 声明里带 tools 服务，宿主就绪后才回调——没有声明就永远不会有工具面
  assert.ok(ctx.injects.some((i) => i.services.includes('tools')), 'apply 没声明 ctx.inject(["tools"], ...)')
})

test('save_verdicts 的 tier 参数是三档枚举，从编译后的 parameters 里断言', async () => {
  const { ctx } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const sv = toolOf(ctx, 'baleen_save_verdicts')
  const tier = sv.parameters.properties.verdicts.items.properties.tier
  assert.deepEqual(tier.enum, ['值得看', '可以看', '不值当'])
  assert.equal(tier.type, 'string')
  // verdicts 必填，元素三字段必填：schema 层就把形状锁死
  assert.deepEqual(sv.parameters.required, ['verdicts'])
  assert.deepEqual(sv.parameters.properties.verdicts.items.required, ['id', 'tier', 'why'])
  assert.equal(sv.parameters.properties.verdicts.items.additionalProperties, false)
})

test('全部工具的 name+description+参数拼接后，平台写动词零命中', async () => {
  const { ctx } = await applyOf(freshHome())
  fireToolsInject(ctx)
  assert.ok(ctx.toolRegistry.length > 0, '工具清单是空的，这条断言会变成永真')
  const RED = /评论|私信|点赞|关注|发布|收藏/
  for (const t of ctx.toolRegistry) {
    const blob = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })
    assert.doesNotMatch(blob, RED, `工具 ${t.name} 的文案出现平台写动词`)
  }
})

test('baleen.collect / baleen.folder / baleen.run / feedback 都不在清单（subtitle 自 M4a 起是合法第六个）', async () => {
  const { ctx } = await applyOf(freshHome())
  fireToolsInject(ctx)
  for (const banned of ['baleen.collect', 'baleen.folder', 'baleen.run', 'baleen.feedback']) {
    assert.ok(!ctx.toolRegistry.some((t) => t.name === banned), `${banned} 不该注册成工具`)
  }
})

/* ---------------- 红线：defineTool 本地回退 ---------------- */

test('本地回退：宿主包不可达时 resolveDefineTool 返回本地 defineTool，构造物与宿主形态同构', async () => {
  const r = await resolveDefineTool()
  // 测试环境没有宿主运行时（无 resourcesPath、node_modules 里也没有 dsh-tools），必走本地
  assert.equal(r.from, 'local')
  assert.equal(typeof r.defineTool, 'function')
  const t = r.defineTool({
    name: 'probe',
    description: '探针',
    parameters: {
      q: { type: 'string', enum: ['a', 'b'], required: true, description: '枚举参数' },
      n: { type: 'number', description: '可选数字' },
      list: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { k: { type: 'integer', required: true } } } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args) => args,
  })
  assert.equal(t.name, 'probe')
  assert.equal(typeof t.execute, 'function')
  assert.deepEqual(await t.execute({ x: 1 }), { x: 1 })
  assert.equal(t.parameters.properties.q.type, 'string')
  assert.deepEqual(t.parameters.properties.q.enum, ['a', 'b'])
  assert.deepEqual(t.parameters.required, ['q', 'list'])
  // 嵌套 schema 不许在本地回退里被抹掉：枚举锁死依赖这一层
  assert.equal(t.parameters.properties.list.items.properties.k.type, 'integer')
})

/* ---------------- save_verdicts 封装：去重与短码透传 ---------------- */

test('save_verdicts 同批重复 id 去重保最后一次：judged:1，落库的是后一个判断', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  createRun(baleen.db, 'manual')
  const a = seedItem(baleen.db, { external_id: 'a' })
  const sv = toolOf(ctx, 'baleen_save_verdicts')
  const out = await sv.execute({ verdicts: [
    { id: a, tier: '值得看', why: '前一个判断' },
    { id: a, tier: '可以看', why: '后一个判断' },
  ] })
  assert.equal(out.ok, true)
  assert.equal(out.judged, 1, '重复 id 没去重，同一条被算成两判')
  assert.deepEqual(out.tiers, { '值得看': 0, '可以看': 1, '不值当': 0 })
  assert.match(out.headline, /判了 1 条/)
  const item = baleen.db.prepare('SELECT status, verdict_tier, verdict_why FROM items WHERE id = ?').get(a)
  assert.equal(item.status, 'judged')
  assert.equal(item.verdict_tier, '可以看', '没保最后一次')
  assert.equal(item.verdict_why, '后一个判断')
})

test('save_verdicts 把 store 的短码原样带回：no_item / bad_tier / bad_payload 不吞成 undefined', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  createRun(baleen.db, 'manual')
  const a = seedItem(baleen.db, { external_id: 'a' })
  const sv = toolOf(ctx, 'baleen_save_verdicts')
  const miss = await sv.execute({ verdicts: [{ id: 99999, tier: '值得看', why: 'x' }] })
  assert.equal(miss.ok, false)
  assert.equal(miss.error, 'no_item')
  const badTier = await sv.execute({ verdicts: [{ id: a, tier: '必看', why: '自创档位' }] })
  assert.equal(badTier.error, 'bad_tier')
  const badPayload = await sv.execute({ verdicts: '值得看' })
  assert.equal(badPayload.error, 'bad_payload')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM digests').get().n, 0, '失败的批次不许落 digest')
})

/* ---------------- read_item：截断保护 ---------------- */

test('read_item 超两万字截断并注明原长；不超长给全文；查无给 no_item', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const long = seedItem(baleen.db, { external_id: 'long', body_text: '字'.repeat(25000) })
  const short = seedItem(baleen.db, { external_id: 'short', body_text: '短正文' })
  const ri = toolOf(ctx, 'baleen_read_item')

  const gotLong = await ri.execute({ id: long })
  assert.equal(gotLong.ok, true)
  assert.equal(gotLong.body_text.length, 20000, '截断阈值没生效')
  assert.equal(gotLong.body_truncated, true)
  assert.equal(gotLong.body_original_length, 25000)
  assert.match(gotLong.body_note, /已截断，原长 25000 字/)
  assert.deepEqual(gotLong.match, { group: 'AI', hit: ['MCP'] }, 'match_json 没解析成对象')
  assert.equal(gotLong.url, 'https://e.com/1')
  assert.equal(gotLong.author, '谁')

  const gotShort = await ri.execute({ id: short })
  assert.equal(gotShort.body_text, '短正文')
  assert.equal(gotShort.body_truncated, undefined)

  const miss = await ri.execute({ id: 99999 })
  assert.equal(miss.ok, false)
  assert.equal(miss.error, 'no_item')
})

/* ---------------- query / candidates / run_status 接口 ---------------- */

test('query 默认只给未归档、默认 20 条、上限 100，摘要不含 body_text', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  for (let i = 0; i < 120; i++) seedItem(baleen.db, { external_id: `q${i}` })
  const goneId = seedItem(baleen.db, { external_id: 'gone', status: 'archived' })
  const q = toolOf(ctx, 'baleen_query')

  const dflt = await q.execute({})
  assert.equal(dflt.ok, true)
  assert.equal(dflt.items.length, 20, '默认限量不是 20')
  assert.ok(!dflt.items.some((i) => i.id === goneId), '默认结果里混进了归档条目')
  const capped = await q.execute({ limit: 999 })
  assert.equal(capped.items.length, 100, '上限 100 没生效')
  const archived = await q.execute({ status: 'archived' })
  assert.ok(archived.items.some((i) => i.id === goneId), '显式要归档条目却拿不到')

  const shape = dflt.items[0]
  assert.deepEqual(Object.keys(shape).sort(),
    ['body_state', 'id', 'kind', 'prefilter_score', 'published_at', 'source_id', 'status', 'title', 'verdict_tier'])
  assert.ok(!('body_text' in shape), '摘要不许带正文全文——读全文走 read_item')
})

test('candidates 上限读 preference 的 schedule.max_per_run（缺省 25），total 是待判总数', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'),
    'version: 1\nsources: []\nschedule:\n  max_per_run: 2\n')
  const { ctx, baleen } = await applyOf(home)
  fireToolsInject(ctx)
  for (let i = 0; i < 3; i++) seedItem(baleen.db, { external_id: `c${i}` })
  const cand = toolOf(ctx, 'baleen_candidates')
  const out = await cand.execute({})
  assert.equal(out.ok, true)
  assert.equal(out.max_per_run, 2, '没读到 preference 里的每轮上限')
  assert.equal(out.total, 3, 'total 该是待判总数，不是截断后的条数')
  assert.equal(out.items.length, 2)
  assert.equal(out.max_per_day, 60, '没写每日上限时取缺省 60')
  assert.equal(out.day_left, 60, '今天还没判过，额度是满的')
  assert.ok(!('body_text' in out.items[0]), '候选摘要同 query 形状，不带正文')

  const home2 = freshHome()
  const r2 = await applyOf(home2)
  fireToolsInject(r2.ctx)
  for (let i = 0; i < 30; i++) seedItem(r2.baleen.db, { external_id: `d${i}` })
  const out2 = await toolOf(r2.ctx, 'baleen_candidates').execute({})
  assert.equal(out2.max_per_run, 25, '没写偏好时应取缺省 25')
  assert.equal(out2.items.length, 25, '缺省每日上限 60 不该截断 25 条')
  assert.equal(out2.total, 30)
})

test('candidates 受 max_per_day 当日额度约束：判完就截，额度用完返回空列表而不是报错', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'),
    'version: 1\nsources: []\nschedule:\n  max_per_run: 5\n  max_per_day: 4\n')
  const { ctx, baleen } = await applyOf(home)
  fireToolsInject(ctx)
  // save_verdicts 落 digest 要挂在一轮上（run_id NOT NULL），真实流程里也是先有抓取轮才有待判条目
  createRun(baleen.db, 'schedule', () => 1000)
  for (let i = 0; i < 10; i++) seedItem(baleen.db, { external_id: `m${i}` })
  const cand = toolOf(ctx, 'baleen_candidates')

  // 今天还没判过：额度 4 < 每轮 5，所以按额度截
  const first = await cand.execute({})
  assert.equal(first.max_per_run, 5)
  assert.equal(first.max_per_day, 4)
  assert.equal(first.judged_today, 0)
  assert.equal(first.day_left, 4)
  assert.equal(first.items.length, 4, '每轮 5 但今天只剩 4 条额度 → 只能给 4 条')

  // 判掉 3 条（真写库，走 save_verdicts 落 digest 的同一路径）：今天还剩 1 条额度
  const pick = first.items.slice(0, 3).map(it => ({ id: it.id, tier: '可以看', why: '测额度' }))
  const save = toolOf(ctx, 'baleen_save_verdicts')
  await save.execute({ verdicts: pick })
  const second = await cand.execute({})
  assert.equal(second.judged_today, 3, 'judged_today 要数出今天真判了几条')
  assert.equal(second.day_left, 1)
  assert.equal(second.items.length, 1, '剩 1 条额度就只给 1 条')

  // 额度用光：ok 仍为 true、列表为空、day_left 为 0——配额到了不是库坏了
  await save.execute({ verdicts: [{ id: second.items[0].id, tier: '可以看', why: '测额度' }] })
  const third = await cand.execute({})
  assert.equal(third.ok, true, '额度用完不是错误，别让调用方以为库坏了')
  assert.equal(third.day_left, 0)
  assert.deepEqual(third.items, [])
  assert.ok(third.total > 0, 'total 仍是待判总数（库里还有没判的）')
})

test('run_status 给最近一轮摘要 + counts + inject_prompt 占位', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const rs = toolOf(ctx, 'baleen_run_status')

  const empty = await rs.execute({})
  assert.equal(empty.ok, true)
  assert.equal(empty.last_run, null)
  assert.deepEqual(empty.counts, { new: 0, judged: 0, digest: 0, archived: 0, total: 0 })
  assert.equal(empty.inject_prompt, true, 'Task 3 起接真值：缺省即开')

  const runId = createRun(baleen.db, 'schedule', () => 1000)
  finishRun(baleen.db, runId, { status: 'partial', candidates: 7, judged: 0, per_source: { rss_a: { fetched: 10, error: null } }, gaps: [] }, () => 2000)
  const out = await rs.execute({})
  assert.equal(out.last_run.status, 'partial')
  assert.equal(out.last_run.candidates, 7)
  assert.deepEqual(out.last_run.per_source, { rss_a: { fetched: 10, error: null } })
  assert.deepEqual(out.counts, { new: 0, judged: 0, digest: 0, archived: 0, total: 0 })
})

test('run_status 的 inject_prompt 接真值：读 preference.yaml 的开关，配置 false 就如实报 false', async () => {
  const home = freshHome()
  fs.writeFileSync(path.join(home, 'preference.yaml'),
    'version: 1\nsources: []\ninject_prompt: false\n')
  const { ctx } = await applyOf(home)
  fireToolsInject(ctx)
  const out = await toolOf(ctx, 'baleen_run_status').execute({})
  assert.equal(out.inject_prompt, false, '开关关了工具还在报"开"，用户会以为注入在工作')
  // 缺省时（另一个家目录没写这个键）按默认开报 true
  const r2 = await applyOf(freshHome())
  fireToolsInject(r2.ctx)
  const out2 = await toolOf(r2.ctx, 'baleen_run_status').execute({})
  assert.equal(out2.inject_prompt, true)
})

/* ---------------- baleen_subtitle：第六个工具（M4a，视频字幕现取，只读） ---------------- */

// bili fetch 桩：手法同 test/adapters-bili.test.js（按 URL 路由），
// 只留 subtitle 工具现取路径要用的最少行为（nav 签名 key → view 拿 cid → player/wbi/v2 → aisubtitle json）。
function fakeBiliFetch({ fullText = '现取到的字幕全文。', subtitles = [{ id: 9, lan: 'ai-zh', lan_doc: 'AI 简体', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/fake.json' }] } = {}) {
  const state = { calls: [] }
  const impl = async (url, init = {}) => {
    const u = String(url)
    state.calls.push({ url: u, headers: init?.headers ?? {} })
    const json =
      u.includes('/x/web-interface/nav') ? {
        code: -101, data: { isLogin: false, wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        } }
      }
      : u.includes('/x/web-interface/view') ? { code: 0, data: { bvid: 'BV1xx411c7mD', cid: 1001 } }
      : u.includes('/x/player/wbi/v2') ? { code: 0, data: { subtitle: { subtitles } } }
      : u.includes('aisubtitle.hdslb.com') ? { body: [{ from: 0, to: 1, content: fullText }] }
      : null
    if (json == null) throw new Error(`stub: 未预期的请求 ${u}`)
    return { ok: true, status: 200, json: async () => json }
  }
  impl.state = state
  return impl
}

const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD'
const seedVideo = (db, over = {}) => seedItem(db, {
  kind: 'video', body_text: null, url: VIDEO_URL, external_id: 'BV1xx411c7mD', ...over,
})

// yt-dlp spawn 桩（手法同 test/adapters-yt.test.js，只演工具现取路径要用的形态）：
// --write-auto-subs 调用按 -o 模板目录落盘 <id>.<lang>.<ext> 再退出；
// files:[] 演"没轨"（退出 0 零文件 → no_subtitle），exit/stderr 可组合演失败帧。
const YT_JSON3 = (text) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] })
function fakeYtSpawn({ files = [{ lang: 'zh-Hans', ext: 'json3', text: YT_JSON3('yt 现取的字幕全文') }], exit = 0 } = {}) {
  const state = { spawns: [] }
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    state.spawns.push({ cmd, args: [...args] })
    Promise.resolve().then(() => {
      const url = String(args[args.length - 1])
      const dir = path.dirname(args[args.indexOf('-o') + 1])
      fs.mkdirSync(dir, { recursive: true })
      const id = /watch\?v=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? 'vid'
      for (const f of files) fs.writeFileSync(path.join(dir, `${id}.${f.lang}.${f.ext}`), f.text)
      child.stdout.emit('data', 'ok')
      child.exitCode = exit
      child.emit('exit', child.exitCode)
    })
    return child
  }
  spawnImpl.state = state
  return spawnImpl
}

const YT_WATCH = 'https://www.youtube.com/watch?v=vidA1111111'
const seedYtVideo = (db, over = {}) => seedVideo(db, {
  external_id: 'vidA1111111', url: YT_WATCH, ...over,
})

test('subtitle 的 schema：id 必填整数，description 写明 summary_only 的视频用它补全文、通道是 B 站 / YouTube', async () => {
  const { ctx } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const st = toolOf(ctx, 'baleen_subtitle')
  assert.deepEqual(st.parameters.required, ['id'])
  assert.equal(st.parameters.properties.id.type, 'integer')
  assert.match(st.description, /summary_only/)
  assert.match(st.description, /B 站 \/ YouTube 通道/)
})

test('subtitle 非视频条目给 not_video；查无 / 非整数 id 给 no_item', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const a = seedItem(baleen.db, { external_id: 'art1' }) // kind=article
  const st = toolOf(ctx, 'baleen_subtitle')
  assert.equal((await st.execute({ id: a })).error, 'not_video')
  assert.equal((await st.execute({ id: 99999 })).error, 'no_item')
  assert.equal((await st.execute({ id: '7' })).error, 'no_item')
  assert.equal((await st.execute({})).error, 'no_item')
})

test('subtitle body_state=subtitle 且库内有全文 → 直接回库内文本（from_store），零请求', async () => {
  const fetchImpl = fakeBiliFetch()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl } })
  fireToolsInject(ctx)
  const v = seedVideo(baleen.db, { body_state: 'subtitle', body_text: '库内字幕全文' })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, true)
  assert.equal(out.subtitle_text, '库内字幕全文')
  assert.equal(out.from_store, true)
  assert.equal(out.title, 't')
  assert.equal(out.url, VIDEO_URL)
  assert.equal(out.body_state, 'subtitle')
  assert.equal(fetchImpl.state.calls.length, 0, '库内已有全文就不许再发请求')
})

test('subtitle body_state=missing/burned_in → 现取：view 拿 cid + player/wbi/v2 签名请求，返回全文；每条 bvid 恰好一次 view', async () => {
  const fetchImpl = fakeBiliFetch({ fullText: '现取到的字幕全文。' })
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl } })
  fireToolsInject(ctx)
  const states = ['missing', 'burned_in']
  for (const [i, state] of states.entries()) {
    const v = seedVideo(baleen.db, {
      external_id: `BV1xx411c7m${i}`, url: `https://www.bilibili.com/video/BV1xx411c7m${i}`, body_state: state,
    })
    const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
    assert.equal(out.ok, true, `${state} 态该现取成功`)
    assert.equal(out.subtitle_text, '现取到的字幕全文。')
    assert.equal(out.from_store, false)
    assert.equal(out.body_state, state)
  }
  const views = fetchImpl.state.calls.filter(c => c.url.includes('/x/web-interface/view'))
  assert.equal(views.length, 2, '每次现取恰好一次 view 详情')
  assert.ok(views[0].url.includes('bvid=BV1xx411c7m0'))
  assert.ok(views[1].url.includes('bvid=BV1xx411c7m1'))
  const player = fetchImpl.state.calls.find(c => c.url.includes('/x/player/wbi/v2'))
  assert.ok(player.url.includes('bvid=BV1xx411c7m0') && player.url.includes('cid=1001') && player.url.includes('w_rid='),
    'player 请求带 bvid/cid 且已 wbi 签名')
  assert.ok(fetchImpl.state.calls.filter(c => c.url.includes('/x/web-interface/nav')).length <= 1,
    'wbi key 进程内缓存，第二次现取不再打 nav')
})

test('subtitle detail 成功但没字幕（字幕列表空）→ no_subtitle，不冒充成功', async () => {
  const fetchImpl = fakeBiliFetch({ subtitles: [] })
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl } })
  fireToolsInject(ctx)
  const v = seedVideo(baleen.db, { body_state: 'missing' })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'no_subtitle')
})

test('subtitle 无凭据（cookie 可选）→ 不再 fetch_failed，匿名照跑；有凭据才带 Cookie 头', async () => {
  // freshHome 没有 credentials/bili-cookie.txt —— 旧路线这里会 credentials_missing 拦截
  const anon = fakeBiliFetch()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl: anon } })
  fireToolsInject(ctx)
  const v = seedVideo(baleen.db, { body_state: 'missing' })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, true, 'cookie 缺失不该拦现取')
  assert.equal(out.subtitle_text, '现取到的字幕全文。')
  assert.equal(anon.state.calls.some(c => c.headers.Cookie), false, '匿名请求不带 Cookie 头')
})

test('subtitle 不是 B 站视频（bvid 提取不到）→ no_bvid，零请求', async () => {
  const fetchImpl = fakeBiliFetch()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl } })
  fireToolsInject(ctx)
  const v = seedVideo(baleen.db, {
    external_id: 'yt-xYZ123', url: 'https://example.com/watch?v=x', body_state: 'summary_only', body_text: '只有摘要',
  })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'no_bvid')
  assert.equal(fetchImpl.state.calls.length, 0)
})

test('subtitle 超两万字截断并注明原长（与 read_item 同一阈值，防撑爆会话上下文）', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  fireToolsInject(ctx)
  const v = seedVideo(baleen.db, { body_state: 'subtitle', body_text: '字'.repeat(25000) })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, true)
  assert.equal(out.subtitle_text.length, 20000, '截断阈值没生效')
  assert.equal(out.subtitle_truncated, true)
  assert.equal(out.subtitle_original_length, 25000)
  assert.match(out.subtitle_note, /已截断，原长 25000 字/)
})

/* ---------------- baleen_subtitle：yt 条目现取（M4b Task 2，按 URL 分流） ---------------- */

test('subtitle yt 条目（missing 态）→ yt-dlp 现取：恰一次 spawn（--write-auto-subs + watch URL）、全文返回、tmp 读完即删、bili 通道零请求', async () => {
  const spawnImpl = fakeYtSpawn()
  const fetchImpl = fakeBiliFetch()
  const home = freshHome()
  const { ctx, baleen } = await applyOf(home, { config: { fetchImpl, spawnImpl } })
  fireToolsInject(ctx)
  const v = seedYtVideo(baleen.db, { body_state: 'missing' })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, true)
  assert.equal(out.subtitle_text, 'yt 现取的字幕全文')
  assert.equal(out.from_store, false)
  assert.equal(out.url, YT_WATCH)
  assert.equal(out.body_state, 'missing')
  assert.equal(spawnImpl.state.spawns.length, 1, '现取恰一次 yt-dlp 字幕调用')
  const s = spawnImpl.state.spawns[0]
  assert.equal(s.cmd, 'yt-dlp')
  assert.ok(s.args.includes('--write-auto-subs'))
  assert.equal(s.args.at(-1), YT_WATCH)
  assert.equal(fetchImpl.state.calls.length, 0, 'yt 条目绝不该打 bili 接口')
  assert.equal(fs.existsSync(path.join(home, 'tmp', 'yt-subs', 'vidA1111111')), false, '落盘目录读完即删')
})

test('subtitle yt URL 但提不出视频 id（playlist 页 URL）→ no_bvid + detail 写明，零 spawn 零请求', async () => {
  const spawnImpl = fakeYtSpawn()
  const fetchImpl = fakeBiliFetch()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl, spawnImpl } })
  fireToolsInject(ctx)
  const v = seedYtVideo(baleen.db, {
    external_id: 'PLxyz', url: 'https://www.youtube.com/playlist?list=PLxyz', body_state: 'summary_only',
  })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'no_bvid')
  assert.equal(out.detail, 'YouTube URL 提取不出视频 id')
  assert.equal(spawnImpl.state.spawns.length, 0)
  assert.equal(fetchImpl.state.calls.length, 0)
})

test('subtitle yt 条目库内已有全文（subtitle 态，youtu.be 短链）→ from_store 直回，零 spawn', async () => {
  const spawnImpl = fakeYtSpawn()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { spawnImpl } })
  fireToolsInject(ctx)
  const v = seedYtVideo(baleen.db, {
    url: 'https://youtu.be/vidA1111111?t=30', body_state: 'subtitle', body_text: '库内的 yt 字幕全文',
  })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, true)
  assert.equal(out.subtitle_text, '库内的 yt 字幕全文')
  assert.equal(out.from_store, true)
  assert.equal(spawnImpl.state.spawns.length, 0, '库内已有全文就不许再发请求')
})

test('subtitle yt 现取没拿到轨（零文件、退出 0）→ no_subtitle，不冒充成功', async () => {
  const spawnImpl = fakeYtSpawn({ files: [] })
  const { ctx, baleen } = await applyOf(freshHome(), { config: { spawnImpl } })
  fireToolsInject(ctx)
  const v = seedYtVideo(baleen.db, { body_state: 'summary_only', body_text: '只有简介' })
  const out = await toolOf(ctx, 'baleen_subtitle').execute({ id: v })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'no_subtitle')
  assert.equal(spawnImpl.state.spawns.length, 1)
})

test('按 URL 分流不串道：同库里 bili 条目走 bili fetch、yt 条目走 yt-dlp，各走各的通道', async () => {
  const spawnImpl = fakeYtSpawn()
  const fetchImpl = fakeBiliFetch()
  const { ctx, baleen } = await applyOf(freshHome(), { config: { fetchImpl, spawnImpl } })
  fireToolsInject(ctx)
  const st = toolOf(ctx, 'baleen_subtitle')
  const biliV = seedVideo(baleen.db, { external_id: 'BV1xx411c7mD', body_state: 'missing' })
  const ytV = seedYtVideo(baleen.db, { body_state: 'missing' })
  const ob = await st.execute({ id: biliV })
  const oy = await st.execute({ id: ytV })
  assert.equal(ob.ok && oy.ok, true, '两条都该现取成功')
  assert.equal(ob.subtitle_text, '现取到的字幕全文。')
  assert.equal(oy.subtitle_text, 'yt 现取的字幕全文')
  assert.ok(fetchImpl.state.calls.length > 0 && fetchImpl.state.calls.every(c => !c.url.includes('youtube')),
    'bili 条目只打 bili 接口')
  assert.equal(spawnImpl.state.spawns.length, 1, 'yt-dlp 只为 yt 条目发起')
  assert.equal(spawnImpl.state.spawns[0].args.at(-1), YT_WATCH)
})

/* ---------------- 降级：tools 缺席不炸启动 ---------------- */

test('tools 缺席（inject 回调拿不到 tools）→ apply 不抛、零注册、日志一行', async () => {
  const home = freshHome()
  const { ctx } = await applyOf(home, { withTools: false })
  fireToolsInject(ctx)
  assert.equal(ctx.toolRegistry.length, 0)
  const blob = fs.readFileSync(path.join(home, 'logs', 'diagnostics.jsonl'), 'utf8')
  assert.match(blob, /no_tools/, '降级要留一行日志，别静默变成"工具怎么没了"的悬案')
  // 面板照常：路由仍在，state 读得到
  assert.deepEqual(ctx.registered.map((r) => r.path), ['/api/dsh-baleen'])
})
