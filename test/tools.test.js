import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDefineTool } from '../lib/tools.js'
import { createRun, finishRun } from '../lib/store.js'

// 工具面红线测试。注册清单恰好五个、save_verdicts 唯一写且三档枚举锁死、
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
  const webServer = { register: (def) => { registered.push(def); return () => { def.__disposed = true } } }
  const tools = withTools ? { register: (t) => { toolRegistry.push(t); return () => {} } } : undefined
  process.env.BALEEN_HOME = home
  return {
    registered, provided, effects, disposes, toolRegistry,
    get: (n) => (n === 'webServer' ? webServer : n === 'tools' ? tools : undefined),
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

const applyOf = async (home, opts = {}) => {
  const ctx = makeCtx(home, opts)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
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

test('注册清单恰好 5 个，名字与 spec §10.1 逐字一致（subtitle 留 M4）', async () => {
  const { ctx } = await applyOf(freshHome())
  assert.deepEqual(ctx.toolRegistry.map((t) => t.name), [
    'baleen.query', 'baleen.read_item', 'baleen.candidates', 'baleen.run_status', 'baleen.save_verdicts',
  ])
  // 每个工具各占一条 effect，label 带上工具名，禁用时宿主按条回收
  assert.deepEqual(ctx.effects.filter((l) => l.startsWith('baleen: tool')), [
    'baleen: tool baleen.query',
    'baleen: tool baleen.read_item',
    'baleen: tool baleen.candidates',
    'baleen: tool baleen.run_status',
    'baleen: tool baleen.save_verdicts',
  ])
})

test('save_verdicts 的 tier 参数是三档枚举，从编译后的 parameters 里断言', async () => {
  const { ctx } = await applyOf(freshHome())
  const sv = toolOf(ctx, 'baleen.save_verdicts')
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
  assert.ok(ctx.toolRegistry.length > 0, '工具清单是空的，这条断言会变成永真')
  const RED = /评论|私信|点赞|关注|发布|收藏/
  for (const t of ctx.toolRegistry) {
    const blob = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })
    assert.doesNotMatch(blob, RED, `工具 ${t.name} 的文案出现平台写动词`)
  }
})

test('baleen.collect / baleen.folder / baleen.run / feedback / subtitle 都不在清单', async () => {
  const { ctx } = await applyOf(freshHome())
  for (const banned of ['baleen.collect', 'baleen.folder', 'baleen.run', 'baleen.feedback', 'baleen.subtitle']) {
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
  createRun(baleen.db, 'manual')
  const a = seedItem(baleen.db, { external_id: 'a' })
  const sv = toolOf(ctx, 'baleen.save_verdicts')
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
  createRun(baleen.db, 'manual')
  const a = seedItem(baleen.db, { external_id: 'a' })
  const sv = toolOf(ctx, 'baleen.save_verdicts')
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
  const long = seedItem(baleen.db, { external_id: 'long', body_text: '字'.repeat(25000) })
  const short = seedItem(baleen.db, { external_id: 'short', body_text: '短正文' })
  const ri = toolOf(ctx, 'baleen.read_item')

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
  for (let i = 0; i < 120; i++) seedItem(baleen.db, { external_id: `q${i}` })
  const goneId = seedItem(baleen.db, { external_id: 'gone', status: 'archived' })
  const q = toolOf(ctx, 'baleen.query')

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
  for (let i = 0; i < 3; i++) seedItem(baleen.db, { external_id: `c${i}` })
  const cand = toolOf(ctx, 'baleen.candidates')
  const out = await cand.execute({})
  assert.equal(out.ok, true)
  assert.equal(out.max_per_run, 2, '没读到 preference 里的每轮上限')
  assert.equal(out.total, 3, 'total 该是待判总数，不是截断后的条数')
  assert.equal(out.items.length, 2)
  assert.ok(!('body_text' in out.items[0]), '候选摘要同 query 形状，不带正文')

  const home2 = freshHome()
  const r2 = await applyOf(home2)
  for (let i = 0; i < 30; i++) seedItem(r2.baleen.db, { external_id: `d${i}` })
  const out2 = await toolOf(r2.ctx, 'baleen.candidates').execute({})
  assert.equal(out2.max_per_run, 25, '没写偏好时应取缺省 25')
  assert.equal(out2.items.length, 25)
  assert.equal(out2.total, 30)
})

test('run_status 给最近一轮摘要 + counts + inject_prompt 占位', async () => {
  const { ctx, baleen } = await applyOf(freshHome())
  const rs = toolOf(ctx, 'baleen.run_status')

  const empty = await rs.execute({})
  assert.equal(empty.ok, true)
  assert.equal(empty.last_run, null)
  assert.deepEqual(empty.counts, { new: 0, judged: 0, digest: 0, archived: 0, total: 0 })
  assert.equal(empty.inject_prompt, null, 'Task 3 接真值前恒为占位 null')

  const runId = createRun(baleen.db, 'schedule', () => 1000)
  finishRun(baleen.db, runId, { status: 'partial', candidates: 7, judged: 0, per_source: { rss_a: { fetched: 10, error: null } }, gaps: [] }, () => 2000)
  const out = await rs.execute({})
  assert.equal(out.last_run.status, 'partial')
  assert.equal(out.last_run.candidates, 7)
  assert.deepEqual(out.last_run.per_source, { rss_a: { fetched: 10, error: null } })
  assert.deepEqual(out.counts, { new: 0, judged: 0, digest: 0, archived: 0, total: 0 })
})

/* ---------------- 降级：tools 缺席不炸启动 ---------------- */

test('tools 缺席（ctx.get 返回 undefined）→ apply 不抛、零注册、日志一行', async () => {
  const home = freshHome()
  const { ctx } = await applyOf(home, { withTools: false })
  assert.equal(ctx.toolRegistry.length, 0)
  assert.deepEqual(ctx.effects.filter((l) => String(l).startsWith('baleen: tool')), [])
  const blob = fs.readFileSync(path.join(home, 'logs', 'diagnostics.jsonl'), 'utf8')
  assert.match(blob, /no_tools/, '降级要留一行日志，别静默变成"工具怎么没了"的悬案')
  // 面板照常：路由仍在，state 读得到
  assert.deepEqual(ctx.registered.map((r) => r.path), ['/api/dsh-baleen'])
})
