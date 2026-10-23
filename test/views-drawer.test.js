import test from 'node:test'
import assert from 'node:assert/strict'
import { Drawer, boundaryNote, feedbackHint } from '../src/client/views/drawer.js'
import { text, findAll } from './helpers/tree.mjs'

const item = (over = {}) => ({
  id: 1, kind: 'video', source_id: 'bili', title: 'DSH 插件怎么写', author: '某人',
  body_state: 'subtitle', body_text: '字幕原文一段', duration_sec: 1102, verdict_tier: null,
  match_json: '{"reason":"命中 DSH（AI 工具）","hitKeywords":["DSH"],"groups":["AI 工具"]}',
  url: 'https://b23.tv/x', ...over
})
const buttons = (tree) => findAll(tree, 'bl-dbtns')[0].children
const btn = (tree, label) => buttons(tree).find((b) => text(b).includes(label))

test('抽屉一定有"为什么给你"和命中词，缺理由要明写', () => {
  const t = text(Drawer({ item: item(), api: {} }))
  assert.match(t, /为什么给你/)
  assert.match(t, /命中 DSH/)
  assert.match(t, /命中词：DSH（AI 工具）/)
  const t2 = text(Drawer({ item: item({ match_json: '{}' }), api: {} }))
  assert.match(t2, /（这条没写理由）/)
})

test('坏 match_json 不炸抽屉，按没写理由处理', () => {
  assert.match(text(Drawer({ item: item({ match_json: '{坏' }), api: {} })), /（这条没写理由）/)
})

test('能力边界按 kind 与源给不同说法，不许假装现在就能播', () => {
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'bili' })), /M4 接入/)
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'xhs' })), /只能跳/)
  assert.match(boundaryNote(item({ kind: 'article', source_id: 'substack', body_state: 'summary_only' })), /只给摘要/)
  assert.match(boundaryNote(item({ kind: 'video', body_state: 'burned_in' })), /硬字幕/)
  assert.match(boundaryNote(item({ kind: 'video', body_state: 'missing' })), /读不到/)
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'bili' })), /现在只能跳到浏览器里看/)
})

test('两个按钮的说明写清只调来源权重、不动主题词', () => {
  const t = text(Drawer({ item: item(), api: {} }))
  assert.match(t, /不感兴趣/)
  assert.match(t, /收藏/)
  assert.match(t, /只改来源权重|只调来源权重/)
  assert.match(t, /不改你的主题词|一个字没动/)
  assert.match(feedbackHint('dismiss'), /-0\.1/)
  assert.match(feedbackHint('save'), /\+0\.1/)
  assert.notEqual(feedbackHint('dismiss'), feedbackHint('save'))
})

test('点击调 api.feedback 并把结果回显，不静默失败', async () => {
  const calls = []
  const done = []
  const api = { feedback: async (s, a) => { calls.push([s, a]); return { ok: true, stale: false, data: { tuning: { bili: -0.1 } } } } }
  const tree = Drawer({ item: item(), api, onDone: (r) => done.push(r) })
  await btn(tree, '不感兴趣').props.onClick()
  assert.deepEqual(calls, [['bili', 'dismiss']])
  assert.equal(done.length, 1)
  assert.match(done[0].message, /bili 权重 -0\.1/)
})

test('api 失败时显示"没记上"，不假装成功', async () => {
  const done = []
  const api = { feedback: async () => ({ ok: false, stale: true, error: 'HTTP 500' }) }
  const tree = Drawer({ item: item(), api, onDone: (r) => done.push(r) })
  await btn(tree, '收藏').props.onClick()
  assert.match(done[0].message, /没记上/)
  assert.match(done[0].message, /HTTP 500/)
})

test('api 没接上（宿主路由缺席）也算失败，不是无事发生', async () => {
  const done = []
  const tree = Drawer({ item: item(), api: {}, onDone: (r) => done.push(r) })
  await btn(tree, '不感兴趣').props.onClick()
  assert.match(done[0].message, /没记上/)
})

test('抽屉把上一次反馈的结果念出来，不留"点了不知道有没有用"的悬念', () => {
  const t = text(Drawer({ item: item(), api: {}, note: 'bili 权重 -0.1——只改 tuning' }))
  assert.match(t, /bili 权重 -0\.1/)
})

test('关闭按钮只负责关，不做别的', () => {
  let closed = 0
  const tree = Drawer({ item: item(), api: {}, onClose: () => { closed++ } })
  findAll(tree, 'bl-dbar')[0].children.find((n) => n.type === 'button').props.onClick()
  assert.equal(closed, 1)
})

test('条目不在手里时抽屉说清楚，不画一个空壳对话框', () => {
  const t = text(Drawer({ item: null, api: {} }))
  assert.match(t, /这条不在当前列表里/)
  assert.doesNotMatch(t, /为什么给你/)
})

test('已判过的条目在抽屉里显示档位与判断理由', () => {
  const t = text(Drawer({ item: item({ verdict_tier: '值得看', verdict_why: '给了源码路径' }), api: {} }))
  assert.match(t, /值得看/)
  assert.match(t, /给了源码路径/)
})

test('原文为空时写"读不到"而不是空白，且带 body_state 的说法', () => {
  const t = text(Drawer({ item: item({ body_text: null, body_state: 'missing' }), api: {} }))
  assert.match(t, /（没有可读内容）/)
  assert.match(t, /读不到/)
})
