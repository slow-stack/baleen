import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchXhs, noteUrl } from '../lib/adapters/xhs.js'
import { XHS_READ_TOOLS, createXhsHttpClient } from '../lib/mcp/xhs-client.js'
import { normalize } from '../lib/normalize.js'

/**
 * fetch 打桩：不启真服务器（node --test 与文件内 http 服务器组合会挂进程，2026-11-01
 * 实测退回 mock 路线），按 JSON-RPC 方法/工具名路由。响应形状与官方 v2.5.5 冒烟实测
 * 一致：tools/call 以 text 形态回 JSON 或说明文本。
 */
function fakeFetch({ loginText = '✅ 已登录\n用户名: 冒烟机', searchFeeds = null, detailFor = () => null, calls = [] } = {}) {
  return async function mockedFetch(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {}
    const name = body.method === 'tools/call' ? body.params.name : body.method
    calls.push(name)
    const reply = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' } })
    if (body.method === 'initialize') return reply({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'fake-xhs' } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 204 })
    if (body.method === 'tools/call') {
      if (name === 'check_login_status') return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: loginText }] } })
      if (name === 'search_feeds') {
        if (searchFeeds == null) return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"feeds":[]}' }] } })
        return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(searchFeeds) }] } })
      }
      if (name === 'get_feed_detail') return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(detailFor(body.params.arguments)) }] } })
      return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    }
    return new Response(null, { status: 404 })
  }
}

/** mock 挂上/还原的样板：restore 必须在 finally 里调。 */
function withMockFetch(opts) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = fakeFetch({ ...opts, calls })
  const client = createXhsHttpClient('http://127.0.0.1:1', 'tok')
  return { client, calls, restore: () => { globalThis.fetch = realFetch } }
}

const feedOf = (id, over = {}) => ({
  id, xsecToken: 'tok-' + id, modelType: 'note',
  noteCard: { type: 'normal', displayTitle: '标题' + id, user: { nickname: '作者' + id, userId: 'u' + id }, interactInfo: { likedCount: '12', collectedCount: '3', commentCount: '4' }, ...over }
})
const detailOf = (id, over = {}) => ({
  id, xsecToken: 'tok-' + id, type: 'normal', title: '标题' + id, desc: '正文' + id,
  user: { nickname: '作者' + id, userId: 'u' + id },
  interactInfo: { likedCount: '12', collectedCount: '3', commentCount: '4' },
  time: 1793500000000, ...over
})
const SOURCE = { id: 'xhs-test', type: 'xhs', url: 'https://www.xiaohongshu.com/search?query=' + encodeURIComponent('测试') }
const SOURCE_QUERY_FIELD = { id: 'xhs-test', type: 'xhs', query: '测试' }
const PREF = { xhs: { mcp_path: '', port: 18060 }, tuning: { source_delta: {} } }

test('只读白名单：写平台工具在客户端就地拒绝，零 HTTP 往返', async () => {
  const { client, calls, restore } = withMockFetch()
  try {
    const rs = await Promise.allSettled([
      client.callTool('like_feed'), client.callTool('publish_content'),
      client.callTool('post_comment_to_feed'), client.callTool('favorite_feed')
    ])
    for (const r of rs) assert.match(String(r.reason?.message ?? ''), /只读白名单/, '写平台工具必须被白名单拒绝')
    assert.deepEqual(calls, [], '被拒的调用不许发出任何 HTTP 请求')
  } finally { restore() }
})

test('XHS_READ_TOOLS 与审查清单一致：9 个只读，不含任何写平台动作', () => {
  assert.deepEqual([...XHS_READ_TOOLS].sort(), [
    'check_login_status', 'get_feed_detail', 'get_login_qrcode', 'get_my_profile',
    'get_unread_count', 'list_feeds', 'list_notifications', 'search_feeds', 'user_profile'
  ])
})

test('未登录 → needs_login（整源跳过，不碰搜索）', async () => {
  const { client, calls, restore } = withMockFetch({ loginText: '❌ 未登录' })
  try {
    await assert.rejects(
      fetchXhs(SOURCE, { pref: PREF, mcp: client }),
      (e) => e.error_class === 'needs_login' && /未登录/.test(e.message)
    )
    assert.deepEqual(
      calls.filter((n) => n !== 'initialize' && n !== 'notifications/initialized'),
      ['check_login_status'], '未登录时不许再发搜索请求'
    )
  } finally { restore() }
})

test('mcp_missing：mcp_path 未配置时零副作用失败', async () => {
  await assert.rejects(
    fetchXhs(SOURCE, { pref: { xhs: { mcp_path: '', port: 18060 } }, mcp: null }),
    (e) => e.error_class === 'mcp_missing'
  )
})

test('关键词两种写法：url query 参数（表回传形态）与 query 字段（直调形态）', async () => {
    const { client, restore } = withMockFetch({ searchFeeds: { feeds: [feedOf('k1')] }, detailFor: (args) => detailOf(args.feed_id) })
    try {
      const items = await fetchXhs(SOURCE_QUERY_FIELD, { pref: PREF, mcp: client })
      assert.equal(items[0].external_id, 'k1')
      const items2 = await fetchXhs({ id: 'x2', type: 'xhs', url: 'https://www.xiaohongshu.com/search?query=' + encodeURIComponent('咖啡') }, { pref: PREF, mcp: client })
      assert.equal(items2[0].external_id, 'k1')
    } finally { restore() }
})

test('摄取链路：搜索 → 逐条详情 → RawItem 映射（含 normalize 的 note 归类）', async () => {
  const { client, restore } = withMockFetch({
    searchFeeds: { feeds: [feedOf('a1'), feedOf('a2')] },
    detailFor: (args) => detailOf(args.feed_id)
  })
  try {
    const items = await fetchXhs(SOURCE, { pref: PREF, mcp: client })
    assert.equal(items.length, 2)
    const first = items[0]
    assert.equal(first.source_id, 'xhs-test')
    assert.equal(first.external_id, 'a1')
    assert.equal(first.note_type, 'image', '图文笔记的形态位走 M1 预留的 image→note')
    assert.equal(first.title, '标题a1')
    assert.equal(first.author, '作者a1')
    assert.equal(first.url, noteUrl('a1', 'tok-a1'))
    assert.match(first.url, /xsec_token=tok-a1/)
    assert.equal(first.published_at, 1793500000000)
    assert.deepEqual(first.stats, { likes: 12, collects: 3, comments: 4 })
    assert.match(first.body_html, /正文a1/)
    const row = normalize(first, SOURCE, PREF)
    assert.equal(row.kind, 'note')
    assert.equal(row.source_id, 'xhs-test')
    assert.ok(row.body_state === 'full' || row.body_state === 'summary_only')
  } finally { restore() }
})

test('视频笔记：note_type=video 带 duration，normalize 归 video', async () => {
  const { client, restore } = withMockFetch({
    searchFeeds: { feeds: [feedOf('v1', { noteCard: { type: 'video', displayTitle: '视频标题', user: { nickname: 'V' }, interactInfo: { likedCount: '1' }, video: { capa: { duration: 75.4 } } } })] },
    detailFor: (args) => detailOf(args.feed_id, { type: 'video', video: { capa: { duration: 75.4 } } })
  })
  try {
    const items = await fetchXhs(SOURCE, { pref: PREF, mcp: client })
    assert.equal(items[0].note_type, 'video')
    assert.equal(items[0].duration_sec, 75)
    const row = normalize(items[0], SOURCE, PREF)
    assert.equal(row.kind, 'video')
  } finally { restore() }
})

test('knownIds 跳过发生在详情之前；每轮上限 12 条（预算分批）', async () => {
  const feeds = { feeds: Array.from({ length: 15 }, (_, i) => feedOf('n' + (i + 1))) }
  const detailIds = []
  const { client, restore } = withMockFetch({
    searchFeeds: feeds,
    detailFor: (args) => { detailIds.push(args.feed_id); return detailOf(args.feed_id) }
  })
  try {
    const items = await fetchXhs(SOURCE, { pref: PREF, mcp: client, knownIds: new Set(['n1']) })
    assert.equal(items.length, 6, '15 条新 - 1 已知 - 上限 6（余量分批留给下轮）')
    assert.equal(detailIds.length, 6)
    assert.equal(detailIds.includes('n1'), false, '已知的不发详情')
    assert.deepEqual(items.map((i) => i.external_id), ['n2', 'n3', 'n4', 'n5', 'n6', 'n7'], '从最旧的已知之后接着排')
  } finally { restore() }
})

test('空搜索如实报 empty；单条详情失败只跳过该条，不掀翻整源', async () => {
  { // 空搜索（bili 同款约定：err.empty 标记，pool 负责归类 'empty'）
    const { client, restore } = withMockFetch({ searchFeeds: { feeds: [] } })
    try {
      await assert.rejects(fetchXhs(SOURCE, { pref: PREF, mcp: client }), (e) => e.empty === true)
    } finally { restore() }
  }
  { // 详情全炸：整源空手而归但不抛
    const { client, restore } = withMockFetch({
      searchFeeds: { feeds: [feedOf('x1'), feedOf('x2')] },
      detailFor: () => { throw new Error('xsec_token 失效') }
    })
    try {
      const items = await fetchXhs(SOURCE, { pref: PREF, mcp: client })
      assert.deepEqual(items, [])
    } finally { restore() }
  }
})

test('noteUrl：xsec_token 随 URL 保全（详情接口的入场券）', () => {
  assert.equal(noteUrl('abc', 'T0K'), 'https://www.xiaohongshu.com/explore/abc?xsec_token=T0K&xsec_source=pc_search')
})
