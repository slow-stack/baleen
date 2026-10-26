import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRun, finishRun } from '../lib/store.js'

// 判断轮触发器（spec §10.2 / M3 Task 3）：ctx.on('system-prompt/assemble') 的注入行为。
// ctx 桩手法同 test/tools.test.js 的 makeCtx，同款加 on 注册桩——测试里手动触发
// handler 断言 assembly 变化。红线：注入文本零正文、零 URL、零用户可编辑自由文本
// （themes/charter 一个字不进），这些断言在任何后续改动中红了就是事故。

const homes = []
const dbs = []
const freshHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-inject-'))
  homes.push(d)
  return d
}
after(() => {
  for (const db of dbs) db.close()
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

function makeCtx(home) {
  const provided = new Map()
  const effects = []
  const disposes = []
  const registered = []
  const injects = []
  const webServer = { register: (def) => { registered.push(def); return () => {} } }
  process.env.BALEEN_HOME = home
  return {
    provided, effects, disposes, registered, injects,
    get: (n) => (n === 'webServer' ? webServer : undefined),
    inject: (services, callback) => { injects.push({ services, callback }) },
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

const applyOf = async (home) => {
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  return { ctx, baleen }
}

/**
 * 手动触发注入：ctx.inject(['systemPrompt'], callback) 的回调里拿 promptCtx，
 * 桩的 systemPrompt.context 记录段落定义并**立即渲染 text 回调**（与宿主每轮渲染同构），
 * 空串不占位（宿主对空 text 的行为）——返回形状与旧版 fireAssemble 一致：
 * `{ sections: [{ name, text }] }`，测试正文零改动。
 */
const fireAssemble = async (ctx) => {
  const inj = ctx.injects.find((i) => i.services.includes('systemPrompt'))
  if (!inj) return null
  const sections = []
  const promptCtx = {
    systemPrompt: {
      context: (def) => { sections.push(def); return () => {} },
      section: (def) => { sections.push(def); return () => {} },
    },
  }
  inj.callback(promptCtx)
  return {
    sections: sections
      .map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text() : s.text }))
      .filter((s) => s.text),
  }
}

const writePref = (home, extra = '') => {
  fs.writeFileSync(path.join(home, 'preference.yaml'), 'version: 1\nsources: []\n' + extra)
}

const seedItem = (db, over = {}) => {
  db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, author, body_text, body_state,
    prefilter_score, fetched_at, published_at, status)
    VALUES ('s1', @external_id, 'article', @title, 'https://e.com/x', '作者', @body_text, 'full',
    5, 1000, 900, 'new')`)
    .run({ external_id: 'e1', title: '默认标题', body_text: '默认正文', ...over })
  return db.prepare('SELECT id FROM items ORDER BY id DESC LIMIT 1').get().id
}

const seedRun = (db, perSource, status = 'partial') => {
  const runId = createRun(db, 'schedule', () => 1000)
  finishRun(db, runId, { status, candidates: 0, judged: 0, per_source: perSource, gaps: [] }, () => 2000)
  return runId
}

const sectionOf = (r) => r?.sections?.find((s) => s.name === 'dsh-baleen:pending') ?? null

/* ---------------- 三件套与红线 ---------------- */

test('有候选时注入三件套：待判数、Top 标题、工具名；正文/URL/themes/charter 零进注入', async () => {
  const home = freshHome()
  writePref(home, 'themes:\n  - group: 绝密主题组\n    any: [标记]\ncharter: 绝密章程词\n')
  const { ctx, baleen } = await applyOf(home)
  seedItem(baleen.db, { external_id: 'a', title: '上下文工程实战手记', body_text: '绝密正文标记甲乙丙' })
  seedItem(baleen.db, { external_id: 'b' })
  const sec = sectionOf(await fireAssemble(ctx))
  assert.ok(sec, '候选 >0 却没有注入段（钩子没挂或静默条件写错）')
  assert.match(sec.text, /待判 2 条/, '注入文本里没有待判数')
  assert.ok(sec.text.includes('上下文工程实战手记'), '注入文本里没有 Top 标题')
  assert.ok(sec.text.includes('baleen_candidates'), '注入文本里没有候选工具名')
  assert.ok(sec.text.includes('read_item') && sec.text.includes('save_verdicts'), '注入文本里没有读写工具名')
  // 红线：注入是触发器不是内容管道（spec §10.2）
  assert.doesNotMatch(sec.text, /http/i, 'URL 进了注入文本')
  assert.ok(!sec.text.includes('绝密正文标记'), '条目正文进了注入文本')
  assert.ok(!sec.text.includes('绝密主题组'), 'themes（用户自由文本）进了注入文本')
  assert.ok(!sec.text.includes('绝密章程词'), 'charter（用户自由文本）进了注入文本')
})

test('Top3 满载 + 失败源满载时文本仍 ≤200 字；长标题与长源 id 都被截断', async () => {
  const home = freshHome()
  writePref(home)
  const { ctx, baleen } = await applyOf(home)
  for (let i = 0; i < 12; i++) {
    seedItem(baleen.db, {
      external_id: `n${i}`,
      title: i < 3 ? `头部标题第${i}号${'垫'.repeat(30)}尾部特征` : `普通标题${i}`,
    })
  }
  seedRun(baleen.db, {
    'bad-source-1': { ok: false, fetched: 0, error_class: 'net' },
    'good-src': { ok: true, fetched: 3 },
    'bad-source-2': { ok: false, fetched: 0, error_class: 'net' },
    'bad-source-3': { ok: false, fetched: 0, error_class: 'net' },
  })
  const sec = sectionOf(await fireAssemble(ctx))
  assert.ok(sec, '满载场景反而没了注入段')
  assert.ok(sec.text.length <= 200, `注入文本超 200 字：${sec.text.length}`)
  assert.ok(!sec.text.includes('尾部特征'), '长标题没截断，整段进了会话')
  assert.ok(sec.text.includes('头部标题第0号'), 'Top 标题头被截没了')
  assert.match(sec.text, /失败 bad-source-1；bad-source-2；bad-source-3/, '失败源清单不是预期那三个')
})

/* ---------------- 静默条件 ---------------- */

test('候选 0 且无失败源时完全不注入：空库、全正常的一轮、进行中的一轮都安静', async () => {
  const home = freshHome()
  writePref(home)
  const { ctx, baleen } = await applyOf(home)
  assert.equal((await fireAssemble(ctx))?.sections.length ?? -1, 0, '空库（连 run 都没有）不该注入')
  seedRun(baleen.db, { 'ok-src': { ok: true, fetched: 2 } }, 'done')
  assert.equal((await fireAssemble(ctx))?.sections.length ?? -1, 0, '全正常的一轮不该注入')
  createRun(baleen.db, 'schedule', () => 3000) // status='running'，per_source 还没落
  assert.equal((await fireAssemble(ctx))?.sections.length ?? -1, 0, '进行中的一轮不该注入')
})

test('进行中的一轮不谎报：有候选时照常注入，但没有「上轮源」段', async () => {
  const home = freshHome()
  writePref(home)
  const { ctx, baleen } = await applyOf(home)
  seedItem(baleen.db)
  createRun(baleen.db, 'schedule', () => 3000)
  const sec = sectionOf(await fireAssemble(ctx))
  assert.ok(sec, '有候选该注入')
  assert.ok(!sec.text.includes('上轮源'), '轮次没跑完就报「全部正常」是谎报')
})

/* ---------------- 开关 ---------------- */

test('inject_prompt: false 时不注入；显式 true 与缺省都注入', async () => {
  const off = freshHome()
  writePref(off, 'inject_prompt: false\n')
  const o = await applyOf(off)
  seedItem(o.baleen.db)
  assert.equal((await fireAssemble(o.ctx))?.sections.length ?? -1, 0, '开关关了还在注入')

  const on = freshHome()
  writePref(on, 'inject_prompt: true\n')
  const i = await applyOf(on)
  seedItem(i.baleen.db)
  assert.ok(sectionOf(await fireAssemble(i.ctx)), '显式 true 也要注入')

  const dflt = freshHome()
  writePref(dflt)
  const f = await applyOf(dflt)
  seedItem(f.baleen.db)
  assert.ok(sectionOf(await fireAssemble(f.ctx)), '缺省（默认开）要注入')
})

/* ---------------- 失败源 ---------------- */

test('失败源进注入：只报 ok=false 的 id，最多 3 个；候选 0 也因失败注入', async () => {
  const home = freshHome()
  writePref(home)
  const { ctx, baleen } = await applyOf(home)
  seedRun(baleen.db, {
    'bad-a': { ok: false, fetched: 0, error_class: 'net' },
    'good-b': { ok: true, fetched: 4 },
    'bad-c': { ok: false, fetched: 0, error_class: 'parse' },
    'bad-d': { ok: false, fetched: 0, error_class: 'net' },
    'bad-e': { ok: false, fetched: 0, error_class: 'net' },
  })
  const sec = sectionOf(await fireAssemble(ctx))
  assert.ok(sec, '有失败源就算候选 0 也要注入（修源也是判断轮的事）')
  assert.ok(!sec.text.includes('待判'), '候选 0 不该有「待判」段')
  for (const id of ['bad-a', 'bad-c', 'bad-d']) {
    assert.ok(sec.text.includes(id), `失败源 ${id} 没进注入：${sec.text}`)
  }
  assert.ok(!sec.text.includes('bad-e'), '失败源该截到 3 个')
  assert.ok(!sec.text.includes('good-b'), '正常源不进失败名单')
})
