import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPreference, validate, bumpTuning, bumpTuningFile, readTuning, ensurePreferenceFile, DEFAULTS } from '../lib/preference.js'

// 测试自清（终审 #21）：目录登记进 tmpDirs，收尾钩子统一删——不往系统临时目录堆 baleen-* 残留。
// 断言都在测试体内读目录，after 晚于它们跑，没有断言还要回头读这里。
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-pref-'))
  tmpDirs.push(d)
  return d
}

test('文件缺失时用内置默认并标明来源', () => {
  const { pref, errors, source } = loadPreference(tmp())
  assert.equal(source, 'defaults')
  assert.deepEqual(errors, [])
  assert.equal(pref.schedule.max_per_run, 25)
})

test('合法文件被采纳', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'preference.yaml'), [
    'version: 1',
    'themes:',
    '  - group: AI',
    '    any: [MCP, 智能体]',
    '    never: [盘点合集]',
    '    weight: 1.0',
    'sources:',
    '  - id: blog-a',
    '    type: rss',
    '    url: https://example.com/feed',
    '    interval_min: 720',
    '    weight: 0.8',
    'schedule:',
    '  windows: ["07:00-09:00"]',
    '  max_per_run: 10',
    '  max_per_day: 40',
    ''
  ].join('\n'))
  const good = loadPreference(d)
  assert.equal(good.source, 'file')
  assert.deepEqual(good.errors, [])
  assert.equal(good.pref.sources[0].id, 'blog-a')
  assert.equal(good.pref.sources[0].url, 'https://example.com/feed')
  assert.deepEqual(good.pref.schedule.windows, ['07:00-09:00'])
})

test('时段窗写错时报出字段路径，且不返回半成品', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'preference.yaml'), 'schedule:\n  windows: ["7am-9am"]\n')
  const bad = loadPreference(d)
  assert.equal(bad.source, 'defaults')
  assert.ok(bad.errors.some(e => e.startsWith('schedule.windows[0]')), bad.errors.join('|'))
  assert.equal(bad.pref.schedule.max_per_run, DEFAULTS.schedule.max_per_run)
})

test('源 id 重复与 rss 缺 url 都被拒', () => {
  const errs = validate({
    version: 1,
    sources: [
      { id: 'a', type: 'rss', url: 'https://x/f' },
      { id: 'a', type: 'rss', url: 'https://y/f' },
      { id: 'b', type: 'rss' }
    ]
  })
  assert.ok(errs.some(e => /重复/.test(e)), errs.join('|'))
  assert.ok(errs.some(e => e.startsWith('sources[2].url')), errs.join('|'))
})

test('未知类型与越界权重被拒', () => {
  const errs = validate({ version: 1, sources: [{ id: 'x', type: 'weibo', url: 'https://e/f' }], themes: [{ group: 'g', weight: 9 }] })
  assert.ok(errs.some(e => e.startsWith('sources[0].type')), errs.join('|'))
  assert.ok(errs.some(e => e.startsWith('themes[0].weight')), errs.join('|'))
})

test('坏 YAML 报解析失败而不是崩掉调用方', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'preference.yaml'), 'themes: [\n  unclosed\n')
  const r = loadPreference(d)
  assert.equal(r.source, 'defaults')
  assert.ok(r.errors.some(e => /解析失败/.test(e)), r.errors.join('|'))
})

test('两个按钮只写 tuning，themes 一个字节都不动', () => {
  const base = { themes: [{ group: 'AI', any: ['MCP'], weight: 1.0 }], tuning: { source_delta: {} } }
  const after = bumpTuning(base, 'blog-a', -0.1)
  assert.deepEqual(after.themes, base.themes)
  assert.equal(after.tuning.source_delta['blog-a'], -0.1)
  let p = after
  for (let i = 0; i < 20; i++) p = bumpTuning(p, 'blog-a', -0.1)
  assert.equal(p.tuning.source_delta['blog-a'], -0.5)
  for (let i = 0; i < 30; i++) p = bumpTuning(p, 'blog-a', 0.1)
  assert.equal(p.tuning.source_delta['blog-a'], 0.5)
})

test('tuning.json 合并进偏好，且用户的 yaml 不被改动', () => {
  const d = tmp()
  const original = 'version: 1\nsources:\n  - id: blog-a\n    type: rss\n    url: https://e.com/f\n'
  fs.writeFileSync(path.join(d, 'preference.yaml'), original)
  assert.deepEqual(readTuning(d), {})
  assert.deepEqual(bumpTuningFile(d, 'blog-a', -0.1), { 'blog-a': -0.1 })
  const { pref } = loadPreference(d)
  assert.deepEqual(pref.tuning.source_delta, { 'blog-a': -0.1 })
  assert.equal(fs.readFileSync(path.join(d, 'preference.yaml'), 'utf8'), original)
})

test('tuning.json 累加到 0 就删键，越界被夹住，坏内容被忽略', () => {
  const d = tmp()
  let t = bumpTuningFile(d, 'x', -0.1)
  t = bumpTuningFile(d, 'x', 0.1)
  assert.deepEqual(t, {})
  for (let i = 0; i < 30; i++) t = bumpTuningFile(d, 'x', -0.1)
  assert.deepEqual(t, { x: -0.5 })
  fs.writeFileSync(path.join(d, 'tuning.json'), '{坏掉的')
  assert.deepEqual(readTuning(d), {})
  fs.writeFileSync(path.join(d, 'tuning.json'), JSON.stringify({ ok: 0.2, huge: 9, nan: 'x' }))
  assert.deepEqual(readTuning(d), { ok: 0.2 })
})

test('ensurePreferenceFile 幂等，不覆盖已存在的文件', () => {
  const d = tmp()
  const p1 = ensurePreferenceFile(d)
  fs.writeFileSync(p1, 'version: 1\nthemes: []\n')
  const p2 = ensurePreferenceFile(d)
  assert.equal(p1, p2)
  assert.match(fs.readFileSync(p2, 'utf8'), /themes: \[\]/)
})

test('inject_prompt 是顶层布尔：缺省 true，写非布尔值整份退回默认', () => {
  const d = tmp()
  const errs = validate({ inject_prompt: 'yes' })
  assert.ok(errs.some(e => e.startsWith('inject_prompt')), errs.join('|'))
  fs.writeFileSync(path.join(d, 'preference.yaml'), 'version: 1\ninject_prompt: false\n')
  const r = loadPreference(d)
  assert.deepEqual(r.errors, [])
  assert.equal(r.pref.inject_prompt, false, '合法的 false 要被采纳')
  assert.equal(loadPreference(tmp()).pref.inject_prompt, true, '缺省该是开')
})
