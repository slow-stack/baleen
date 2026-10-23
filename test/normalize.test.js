import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, matchThemes, inferBodyState, inferKind } from '../lib/normalize.js'

const pref = {
  themes: [
    { group: 'AI 工具', must: [], any: ['DSH', 'MCP'], never: ['盘点合集'], weight: 1.0 },
    { group: '考研', must: [], any: ['政策过程'], never: [], weight: 0.8 }
  ],
  follow: { feeds: ['https://example.substack.com/feed'] },
  redlines: ['引流私聊'],
  tuning: { source_delta: {} },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  sources: [{ id: 'blog-a', type: 'rss', url: 'https://example.substack.com/feed', enabled: true, interval_min: 720, weight: 0.8 }]
}
const src = pref.sources[0]
const longBody = '<p>' + '内容'.repeat(220) + '</p>'
const base = {
  source_id: 'blog-a', source_type: 'rss', feed_title: 'Naval Notes',
  external_id: 'e1', url: 'https://e.com/1', title: 'DSH 里的 MCP 怎么接', author: '桉',
  published_at: 1000, body_html: longBody, summary_html: '短', thumb: null,
  duration_sec: null, tags: ['工具'], fetched_at: 2000
}

test('正文够长判 full，只有摘要判 summary_only，两者都空判 missing', () => {
  assert.equal(inferBodyState(base), 'full')
  assert.equal(inferBodyState({ ...base, body_html: null }), 'summary_only')
  assert.equal(inferBodyState({ ...base, body_html: null, summary_html: null }), 'missing')
  assert.equal(inferBodyState({ ...base, body_html: '<p>只有几个字</p>' }), 'summary_only')
  assert.equal(inferBodyState({ ...base, body_html: null, summary_html: null, hardsub_hint: true }), 'burned_in')
  assert.equal(inferBodyState({ ...base, subtitle_text: '字幕原文' }), 'subtitle')
  assert.equal(inferBodyState({ ...base, subtitle_text: null, transcribed_text: '转写原文' }), 'transcribed')
})

test('kind 按内容形态分，不按平台分：图文笔记是 note，视频笔记仍是 video', () => {
  assert.equal(inferKind(src, base), 'article')
  assert.equal(inferKind(src, { ...base, duration_sec: 120 }), 'video')
  assert.equal(inferKind({ id: 'b', type: 'bili' }, base), 'video')
  assert.equal(inferKind({ id: 'x', type: 'xhs' }, { ...base, note_type: 'image' }), 'note')
  assert.equal(inferKind({ id: 'x', type: 'xhs' }, { ...base, note_type: 'video' }), 'video')
})

test('命中理由是人能读的一句话，并带上组名', () => {
  const d = normalize(base, src, pref, () => 9000)
  const m = JSON.parse(d.match_json)
  assert.ok(m.hitKeywords.includes('DSH'))
  assert.ok(m.hitKeywords.includes('MCP'))
  assert.deepEqual(m.groups, ['AI 工具'])
  assert.match(m.reason, /命中/)
  assert.match(m.reason, /DSH/)
  assert.equal(d.status, 'new')
  assert.equal(d.kind, 'article')
  assert.equal(d.body_state, 'full')
  assert.equal(d.time_estimated, 0)          // 有真 pubDate → 不估算
  assert.ok(d.prefilter_score > 0)
})

test('发布时间缺失才标 time_estimated', () => {
  const d = normalize({ ...base, published_at: null }, src, pref, () => 9000)
  assert.equal(d.published_at, null)
  assert.equal(d.time_estimated, 1)
})

test('never 词与 redlines 直接把条目判死，理由写清是哪一条', () => {
  const a = matchThemes('DSH 盘点合集 好用', pref)
  assert.equal(a.rejected, true)
  assert.match(a.reason, /never/)
  const b = matchThemes('MCP 教程，文末引流私聊', pref)
  assert.equal(b.rejected, true)
  assert.match(b.reason, /redline/)
  const d = normalize({ ...base, title: 'DSH 盘点合集' }, src, pref, () => 9000)
  assert.equal(JSON.parse(d.match_json).rejected, true)
})

test('英文关键词按词边界匹配——子串匹配会造假理由', () => {
  // 真实踩过的坑：UI 命中 building、agent 命中 management，理由行因此完全不可信
  const p = { themes: [{ group: 'AI 工具', any: ['UI', 'agent', 'MCP'], never: ['盘点合集'], weight: 1 }], redlines: [] }
  assert.equal(matchThemes('Building resilient software', p).hitKeywords.includes('UI'), false)
  assert.equal(matchThemes('engineering management rules', p).hitKeywords.includes('agent'), false)
  assert.equal(matchThemes('The ROI of spending', p).score, 0)
  assert.equal(matchThemes('The ROI of spending', p).rejected, false)
  // 真命中要认得出来：独立词、连字符旁、大小写混合
  const hit = matchThemes('A multi-agent framework with MCP support', p)
  assert.deepEqual([...hit.hitKeywords].sort(), ['MCP', 'agent'].sort())
  assert.equal(hit.groups[0], 'AI 工具')
  assert.equal(matchThemes('关闭 UI 之后', p).hitKeywords.includes('UI'), true)
})

test('中文关键词仍按子串匹配（中文没有词边界）', () => {
  const p = { themes: [{ group: '考研', any: ['政策过程'], weight: 1 }], redlines: [] }
  assert.ok(matchThemes('今天讲政策过程的阶段', p).hitKeywords.includes('政策过程'))
  assert.equal(matchThemes('今天讲政治过程', p).hitKeywords.length, 0)
})

test('写成大写的关键词按大小写敏感匹配——框架名不该抓散文的动词', () => {
  const p = { themes: [{ group: '前端', any: ['React', 'CSS', 'agent', 'mcp'], weight: 1 }], redlines: [] }
  // 真实踩过的坑：Medium 散文里的 "how we react to" 被判成命中框架名 React
  assert.equal(matchThemes('how we react to things', p).hitKeywords.length, 0)
  assert.equal(matchThemes('A pure CSS migration', p).hitKeywords.includes('CSS'), true)
  assert.equal(matchThemes('Built with React and Vue', p).hitKeywords.includes('React'), true)
  // 全小写的关键词仍不区分大小写：agent 要能命中 Agent
  assert.ok(matchThemes('An Agent framework', p).hitKeywords.includes('agent'))
  assert.ok(matchThemes('The MCP protocol', p).hitKeywords.includes('mcp'))
})

test('全部不命中时得分为 0，不是负数', () => {
  const m = matchThemes('与任何组无关的一句话', pref)
  assert.equal(m.rejected, false)
  assert.equal(m.score, 0)
  assert.equal(m.hitKeywords.length, 0)
})

test('订阅的 feed 给 follow 加分，权重偏移也进总分且可复现', () => {
  const a = normalize(base, src, pref, () => 9000)
  const b = normalize(base, src, pref, () => 9000)
  assert.equal(a.prefilter_score, b.prefilter_score)
  assert.equal(JSON.parse(a.match_json).score_follow, 0.6)

  const unfollowed = normalize(base, { ...src, url: 'https://other.com/feed' }, pref, () => 9000)
  assert.equal(JSON.parse(unfollowed.match_json).score_follow, 0)

  const tuned = normalize(base, src, { ...pref, tuning: { source_delta: { 'blog-a': 0.3 } } }, () => 9000)
  assert.equal(Math.round((tuned.prefilter_score - a.prefilter_score) * 100) / 100, 0.3)
  assert.deepEqual(JSON.parse(tuned.match_json).hitKeywords, JSON.parse(a.match_json).hitKeywords)
})

test('normalize 的产出正好是 items 表的列，不带私货', () => {
  const d = normalize(base, src, pref, () => 9000)
  const cols = ['source_id', 'external_id', 'kind', 'title', 'url', 'author', 'author_id', 'published_at',
    'time_estimated', 'fetched_at', 'thumb', 'duration_sec', 'stats_json', 'tags_json', 'locale',
    'body_text', 'body_state', 'match_json', 'prefilter_score', 'status']
  assert.deepEqual(Object.keys(d).sort(), [...cols].sort())
  assert.equal(d.body_text.includes('内容内容'), true)
})
