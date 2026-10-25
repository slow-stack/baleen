import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { biliAdapter, adapterFor, ADAPTERS } from '../lib/adapters/index.js'
import { parseSpaceUid, parseLength, fetchBiliSubtitle, DM_FINGERPRINT } from '../lib/adapters/bili.js'
import {
  MIXIN_KEY_ENC_TAB, getMixinKey, wbiSignParams, keyFromUrl, createWbiSigner, clearWbiCache,
} from '../lib/adapters/bili-wbi.js'

const source = { id: 'bili-a', type: 'bili', url: 'https://space.bilibili.com/946974', label: '某UP主' }
const NOW = 1730000000000
const WTS = Math.floor(NOW / 1000)

/* ───────────────────────── wbi 签名（自研，零依赖） ─────────────────────────
 * 向量来自公开资料（bilibili-API-collect 的 wbi 文档），置换表是固定常量，
 * 签名纯确定性：固定 img/sub key + 固定 wts ⇒ 唯一 w_rid。 */

test('getMixinKey：64 长度置换表重排 img+sub 取前 32（官方文档向量）', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64)
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8')
})

test('wbiSignParams：官方文档向量 foo/bar/zab + wts=1702204169 → 确定性 w_rid', () => {
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  const signed = wbiSignParams({ foo: 114, bar: 514, zab: 1919810 }, { mixinKey: mixin, wts: 1702204169 })
  assert.equal(signed.wts, 1702204169)
  assert.equal(signed.w_rid, '8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('wbiSignParams：入参键序不影响结果（签名前按 key 排序）', () => {
  const mixin = 'ea1db124af3c7062474693fa704f4ff8'
  const a = wbiSignParams({ foo: 114, bar: 514, zab: 1919810 }, { mixinKey: mixin, wts: 1702204169 })
  const b = wbiSignParams({ zab: 1919810, foo: 114, bar: 514 }, { mixinKey: mixin, wts: 1702204169 })
  assert.equal(a.w_rid, b.w_rid)
})

test("wbiSignParams：值里的 !'()* 先剔除再签名（官方规则；预期值本地预计算）", () => {
  // query = foo=ab&wts=1702204169（"a!'()*b" 剔除后 "ab"）+ mixin → md5
  const signed = wbiSignParams({ foo: "a!'()*b" }, { mixinKey: 'ea1db124af3c7062474693fa704f4ff8', wts: 1702204169 })
  assert.equal(signed.w_rid, '0efb10f0d5f4e47e9c5dc8145b5f4f88')
})

test('wbiSignParams：不改动入参对象（构造新对象带 wts/w_rid）', () => {
  const input = { foo: 1 }
  const signed = wbiSignParams(input, { mixinKey: 'k'.repeat(32), wts: 1 })
  assert.deepEqual(Object.keys(input), ['foo'])
  assert.equal(signed.wts, 1)
  assert.match(signed.w_rid, /^[0-9a-f]{32}$/)
})

test('keyFromUrl：取 wbi 图床文件名（img/sub key 的来源）', () => {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c')
  assert.equal(keyFromUrl('//i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'), '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(keyFromUrl('https://e.com/nokey'), null)
})

test('wbi nav 缓存：进程内复用 mixin key（key 一天一换，不逐请求打 nav），超过 TTL 重取', async () => {
  clearWbiCache()
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => NAV() } }
  const t0 = 1_000_000_000
  await createWbiSigner({ fetchImpl, now: () => t0 }).sign({ a: 1 })
  await createWbiSigner({ fetchImpl, now: () => t0 }).sign({ a: 2 })
  assert.equal(calls, 1, '同一进程内第二次 sign 不该再打 nav')
  await createWbiSigner({ fetchImpl, now: () => t0 + 3600 * 1000 }).sign({ a: 3 })
  assert.equal(calls, 1, '1 小时后仍在 TTL 内，缓存命中')
  await createWbiSigner({ fetchImpl, now: () => t0 + 13 * 3600 * 1000 }).sign({ a: 4 })
  assert.equal(calls, 2, '超过 TTL 重取 nav')
  clearWbiCache()
})

test('wbi signer：nav 响应缺 wbi_img → 报错不缓存（拿不到 key 就诚实失败）', async () => {
  clearWbiCache()
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) })
  await assert.rejects(() => createWbiSigner({ fetchImpl, now: () => 1 }).sign({}), /wbi_img/)
  clearWbiCache()
})

/* ───────────────────────── fetch 桩（手法同 adapters-rss.test.js） ─────────── */

// 匿名 nav（code=-101 但 data.wbi_img 在场——匿名可调，key 用官方文档向量）
const NAV = () => ({
  code: -101, message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
    }
  }
})

const VLIST = () => [
  {
    bvid: 'BV1xx411c7mD', title: 'DSH 插件实战第一期', description: '这期讲适配器怎么写',
    author: 'UP主甲', mid: 946974, length: '12:34', pubdate: 1799848200, created: 1799848200,
    pic: '//i0.hdslb.com/bfs/archive/cover1.jpg', aid: 170001
  },
  {
    bvid: 'BV1yy411c7mE', title: '没有字幕的一期', description: '纯画面演示',
    author: 'UP主甲', mid: 946974, length: '3:05', pubdate: 1799754000, created: 1799754000,
    pic: null, aid: 170002
  }
]
const LIST = () => ({ code: 0, message: '0', data: { list: { vlist: VLIST() }, page: { pn: 1, ps: 30 }, total: 2 } })

const VIEW_FOR = (bvid) => ({
  code: 0, message: '0',
  data: {
    bvid, title: bvid === 'BV1xx411c7mD' ? 'DSH 插件实战第一期' : '没有字幕的一期',
    desc: bvid === 'BV1xx411c7mD' ? '这期讲适配器怎么写' : '纯画面演示',
    duration: bvid === 'BV1xx411c7mD' ? 754 : 185,
    pic: 'https://i0.hdslb.com/bfs/archive/cover1.jpg',
    cid: bvid === 'BV1xx411c7mD' ? 1001 : 1002,
    ctime: bvid === 'BV1xx411c7mD' ? 1799848200 : 1799754000,
    pubdate: bvid === 'BV1xx411c7mD' ? 1799848200 : 1799754000,
    owner: { mid: 946974, name: 'UP主甲' },
    subtitle: { allow_submit: false, list: [] }
  }
})

// player/v2：带 cookie 才有字幕列表；ai-zh 优先（en 那条用来测挑选规则）
const PLAYER = (lans = ['ai-zh']) => ({
  code: 0, message: '0',
  data: {
    subtitle: {
      allow_submit: true,
      subtitles: lans.map((lan, i) => ({
        id: 100 + i, lan, lan_doc: `字幕${lan}`,
        subtitle_url: `//aisubtitle.hdslb.com/bfs/ai_subtitle/fake-${lan}-${i}.json`
      }))
    }
  }
})
const SUB_JSON = (lines = ['大家好', '今天讲适配器。']) => ({
  body: lines.map((content, i) => ({ from: i * 1.2, to: i * 1.2 + 1, content }))
})

/**
 * fetch 桩：按 URL 路由到 handlers.nav/list/view/player/sub。
 * handler 收 ({url, headers})，回 { json }（200+JSON）或 { status }（非 2xx）。
 * state.calls 记录每次请求的 url/headers，供断言请求形态与调用次序。
 */
function fakeFetch(handlers = {}) {
  const state = { calls: [] }
  const impl = async (url, init = {}) => {
    const u = String(url)
    const headers = init?.headers ?? {}
    state.calls.push({ url: u, headers, signal: init?.signal })
    const route =
      u.includes('/x/web-interface/nav') ? 'nav'
      : u.includes('/x/space/wbi/arc/search') ? 'list'
      : u.includes('/x/web-interface/view') ? 'view'
      : u.includes('/x/player/wbi/v2') ? 'player'
      : u.includes('aisubtitle.hdslb.com') ? 'sub' : null
    const h = handlers[route]
    if (!h) throw new Error(`stub: 未配置的路由 ${route ?? u}（${u}）`)
    const r = await h({ url: u, headers })
    if (r?.status != null && r.json == null) return { ok: false, status: r.status, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => r.json }
  }
  impl.state = state
  return impl
}

const defaultHandlers = (over = {}) => ({
  nav: () => ({ json: NAV() }),
  list: () => ({ json: LIST() }),
  view: ({ url }) => ({ json: VIEW_FOR(new URL(url).searchParams.get('bvid')) }),
  // BV1yy411c7mE（cid 1002）就是那条"没有字幕的"：player 回空列表
  player: ({ url }) => ({ json: PLAYER(new URL(url).searchParams.get('cid') === '1002' ? [] : ['ai-zh']) }),
  sub: () => ({ json: SUB_JSON() }),
  ...over
})

// 建临时 BALEEN_HOME；cookie 缺省不带（新路线：cookie 是可选增强，多数测试就跑匿名）
async function withHome(t, { cookie = false } = {}) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'baleen-bili-test-'))
  const prev = process.env.BALEEN_HOME
  process.env.BALEEN_HOME = home
  if (cookie) {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials', 'bili-cookie.txt'), 'SESSDATA=fake-value; bili_jct=fake\n', 'utf8')
  }
  t.after(() => {
    if (prev === undefined) delete process.env.BALEEN_HOME
    else process.env.BALEEN_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

const fetchIt = async (fetchImpl, over = {}) => {
  clearWbiCache()
  return biliAdapter.fetch(source, { since: null, now: () => NOW, fetchImpl, ...over })
}
const subFetch = async (fetchImpl, over = {}) => {
  clearWbiCache()
  return fetchBiliSubtitle('BV1xx411c7mD', { now: () => NOW, fetchImpl, ...over })
}

/* ───────────────────────── 请求形态 ───────────────────────── */

test('请求次序与端点：nav → arc/search 列表 → 逐条 view；UA=Mozilla/5.0 + Referer（照抄 dsh-bili-scroll）', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  await fetchIt(fetchImpl)
  const urls = fetchImpl.state.calls.map(c => c.url)
  assert.ok(urls[0].includes('https://api.bilibili.com/x/web-interface/nav'), urls[0])
  assert.ok(urls[1].includes('https://api.bilibili.com/x/space/wbi/arc/search'), urls[1])
  assert.ok(urls[2].includes('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD'), urls[2])
  assert.ok(urls[3].includes('https://api.bilibili.com/x/web-interface/view?bvid=BV1yy411c7mE'), urls[3])
  for (const c of fetchImpl.state.calls) {
    assert.equal(c.headers['User-Agent'], 'Mozilla/5.0')
    assert.equal(c.headers['Referer'], 'https://www.bilibili.com/')
  }
})

test('列表走 wbi 签名：mid/ps/pn + wts/w_rid，w_rid 用 nav 发下来的 mixin key 确定性可算', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  await fetchIt(fetchImpl)
  const u = new URL(fetchImpl.state.calls.find(c => c.url.includes('arc/search')).url)
  assert.equal(u.searchParams.get('mid'), '946974')
  assert.equal(u.searchParams.get('ps'), '30')
  assert.equal(u.searchParams.get('pn'), '1')
  assert.equal(u.searchParams.get('wts'), String(WTS))
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  const expect = wbiSignParams({ mid: '946974', ps: 30, pn: 1, order: 'pubdate', ...DM_FINGERPRINT }, { mixinKey: mixin, wts: WTS })
  assert.equal(u.searchParams.get('w_rid'), expect.w_rid, '适配器必须真的把 nav 的 key 用进签名')
})

test('列表带 dm_img_* 风控指纹参数（匿名直连 arc/search 的已知解法：缺了就是 412/-352）', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  await fetchIt(fetchImpl)
  const u = new URL(fetchImpl.state.calls.find(c => c.url.includes('arc/search')).url)
  for (const k of Object.keys(DM_FINGERPRINT)) {
    assert.equal(u.searchParams.get(k), DM_FINGERPRINT[k], `缺 ${k}`)
  }
})

test('cookie 可选：有凭据 → api 请求带 Cookie 头；无凭据 → 照跑不拦（字幕按无字幕）', async () => {
  const home = await withHome(test, { cookie: true })
  const fetchImpl = fakeFetch(defaultHandlers())
  await fetchIt(fetchImpl)
  const withCookie = fetchImpl.state.calls.filter(c => c.headers.Cookie)
  assert.ok(withCookie.length >= 4, 'nav/list/view 都带 Cookie')
  assert.equal(withCookie[0].headers.Cookie, 'SESSDATA=fake-value; bili_jct=fake')
  assert.ok(path.join(home, 'credentials', 'bili-cookie.txt'))

  await withHome(test) // 换个没有凭据的家目录
  const anon = fakeFetch(defaultHandlers())
  const items = await fetchIt(anon) // 不再 credentials_missing 拦截
  assert.equal(items.length, 2)
  assert.equal(anon.state.calls.some(c => c.headers.Cookie), false)
})

/* ───────────────────────── RawItem 翻译 ───────────────────────── */

test('RawItem 翻译：bvid 作 external_id、封面 pic、时长取 detail 总秒、published_at 取 pubdate 毫秒', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  const items = await fetchIt(fetchImpl)

  const a = items[0]
  assert.equal(a.source_id, 'bili-a')
  assert.equal(a.source_type, 'bili')
  assert.equal(a.external_id, 'BV1xx411c7mD')
  assert.equal(a.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(a.title, 'DSH 插件实战第一期')
  assert.equal(a.author, 'UP主甲')
  assert.equal(a.thumb, '//i0.hdslb.com/bfs/archive/cover1.jpg')
  assert.equal(a.duration_sec, 754)
  assert.equal(a.published_at, 1799848200 * 1000)
  assert.equal(a.fetched_at, NOW)
  assert.equal(a.tags, null)
  assert.equal(a.locale, null)
})

test('字幕三态（Task 2 裁定不变）：有字幕 → subtitle_text + body=简介\\n\\n字幕；无 → body 留空交给预筛', async () => {
  await withHome(test, { cookie: true })
  const fetchImpl = fakeFetch(defaultHandlers())
  const [a, b] = await fetchIt(fetchImpl)

  assert.equal(a.subtitle_text, '大家好\n今天讲适配器。')
  assert.equal(a.body_html, '这期讲适配器怎么写\n\n大家好\n今天讲适配器。')
  // 无字幕那条（cookie 在但视频没字幕轨）：body=简介（summary_only，进候选），subtitle_text 缺席
  assert.equal(b.subtitle_text, undefined)
  assert.ok(b.body_html && b.body_html.length > 0, '简介非空的视频匿名态也该有 body（summary_only），不能全被预筛丢')
  assert.equal(b.external_id, 'BV1yy411c7mE')
  assert.equal(b.duration_sec, 185)
})

test('字幕挑选：AI/中文字幕优先（ai-zh 胜过 en），subtitle_url 协议相对地址补 https', async () => {
  await withHome(test, { cookie: true })
  const fetchImpl = fakeFetch(defaultHandlers({ player: () => ({ json: PLAYER(['en', 'ai-zh']) }) }))
  const [a] = await fetchIt(fetchImpl)
  assert.equal(a.subtitle_text, '大家好\n今天讲适配器。')
  const subCall = fetchImpl.state.calls.find(c => c.url.includes('aisubtitle.hdslb.com'))
  assert.ok(subCall.url.startsWith('https://aisubtitle.hdslb.com/'), subCall.url)
  assert.ok(subCall.url.includes('fake-ai-zh-1.json'), '挑中的是 ai-zh 那条')
})

test('detail 单条失败不拖垮整源：失败条降级 missing（时长/时间回落列表字段）并留诊断日志', async () => {
  await withHome(test)
  const logs = []
  const fetchImpl = fakeFetch(defaultHandlers({ view: () => ({ json: { code: -404, message: '啥都木有' } }) }))
  const items = await fetchIt(fetchImpl, { log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(items.length, 2)
  assert.equal(items[0].duration_sec, 754, '回落列表 length 字段')
  assert.equal(items[0].published_at, 1799848200 * 1000, '回落列表 pubdate')
  assert.equal(items[0].subtitle_text, undefined)
  assert.ok(logs.some(l => l.event === 'bili_detail_failed' && l.detail.includes('BV1xx411c7mD')))
})

test('detail 撞上风控 412 → 整源失败（游标不推进），不降级 missing', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers({ view: () => ({ status: 412 }) }))
  await assert.rejects(() => fetchIt(fetchImpl), e => e.status === 412)
})

test('风控 HTTP 412 出现在列表层 → 整源失败；player 层 412 同样整源失败（全局 circuit）', async () => {
  await withHome(test)
  const list412 = fakeFetch(defaultHandlers({ list: () => ({ status: 412 }) }))
  await assert.rejects(() => fetchIt(list412), e => e.status === 412)

  await withHome(test, { cookie: true })
  const player412 = fakeFetch(defaultHandlers({ player: () => ({ status: 412 }) }))
  await assert.rejects(() => fetchIt(player412), e => e.status === 412)
})

test('api code=-101（cookie 过期被拒）→ error_class=credentials', async () => {
  await withHome(test, { cookie: true })
  const fetchImpl = fakeFetch(defaultHandlers({ list: () => ({ json: { code: -101, message: '账号未登录' } }) }))
  await assert.rejects(() => fetchIt(fetchImpl), e => e.error_class === 'credentials' && e.status === -101)
})

test('api code=-352（业务码形态的风控）→ 整源失败（列表层 / 详情层都算全局 circuit，不降级 missing）', async () => {
  await withHome(test)
  const list352 = fakeFetch(defaultHandlers({ list: () => ({ json: { code: -352, message: '风控校验失败' } }) }))
  await assert.rejects(() => fetchIt(list352), e => e.status === -352 && /风控/.test(e.message))

  await withHome(test, { cookie: true })
  const view352 = fakeFetch(defaultHandlers({ view: () => ({ json: { code: -352, message: '风控校验失败' } }) }))
  await assert.rejects(() => fetchIt(view352), e => e.status === -352)
})

test('cookie 缺失留一行 need_login 诊断（提示字幕增强未启用），整轮只有一行不逐条刷屏', async () => {
  await withHome(test)
  const logs = []
  await fetchIt(fakeFetch(defaultHandlers()), { log: (event, detail) => logs.push({ event, detail }) })
  const needLogin = logs.filter(l => l.event === 'bili_subtitle_need_login')
  assert.equal(needLogin.length, 1)
  assert.match(needLogin[0].detail, /bili-cookie\.txt/)
})

test('since 不过滤（backlog 语义由 gate 管）：pubdate 很旧的条目照样返回', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  const items = await fetchIt(fetchImpl, { since: 4102444800000 }) // 2100 年，比所有条目都新
  assert.equal(items.length, 2)
})

/* ───────────────────────── signal 全链透传与超时 abort（真机 run 17 的孤儿调用） ─── */

test('signal 全链透传：nav / 列表 / 逐条 view 的每个 fetch init 都带调用方的 signal', async () => {
  await withHome(test)
  const ac = new AbortController()
  const fetchImpl = fakeFetch(defaultHandlers())
  await fetchIt(fetchImpl, { signal: ac.signal })
  const calls = fetchImpl.state.calls
  assert.ok(calls.length >= 4, `nav+list+view×2，实际 ${calls.length} 次`)
  for (const c of calls) assert.equal(c.signal, ac.signal, `这个请求缺 signal：${c.url}`)
})

test('超时 abort 短路：第一条 view 挂起被 abort → 整源立即失败，不再继续打后续 detail（孤儿调用消失）', async () => {
  await withHome(test)
  const ac = new AbortController()
  const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const fetchImpl = fakeFetch(defaultHandlers({
    view: () => ac.signal.aborted
      ? Promise.reject(abortErr())
      : new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(abortErr())))
  }))
  const timer = setTimeout(() => ac.abort(), 10)
  try {
    await assert.rejects(() => fetchIt(fetchImpl, { signal: ac.signal }), e => e.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
  const viewCalls = fetchImpl.state.calls.filter(c => c.url.includes('/x/web-interface/view')).length
  assert.equal(viewCalls, 1, `abort 后不该再打后续 view，实际 ${viewCalls} 次`)
})

/* ───────────────────────── 错误映射 ───────────────────────── */

test('源 url 无 UID → error_class=bad_source，零网络调用', async () => {
  await withHome(test)
  const fetchImpl = fakeFetch(defaultHandlers())
  await assert.rejects(
    () => biliAdapter.fetch({ id: 'b', type: 'bili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, { fetchImpl }),
    e => e.error_class === 'bad_source'
  )
  assert.equal(fetchImpl.state.calls.length, 0)
})

test('列表为 0 条 → e.empty（它不算成功，游标不能推进）；vlist 缺失 → parse', async () => {
  await withHome(test)
  const empty = fakeFetch(defaultHandlers({ list: () => ({ json: { code: 0, data: { list: { vlist: [] } } } }) }))
  await assert.rejects(() => fetchIt(empty), e => e.empty === true)
  const broken = fakeFetch(defaultHandlers({ list: () => ({ json: { code: 0, data: { list: {} } } }) }))
  await assert.rejects(() => fetchIt(broken), e => e.parse === true)
})

test('nav 挂了（HTTP 412 / 缺 wbi_img）→ 整源失败，签名拿不到 key 不硬跑', async () => {
  await withHome(test)
  const http412 = fakeFetch({ nav: () => ({ status: 412 }) })
  await assert.rejects(() => fetchIt(http412), e => e.status === 412)
  const noImg = fakeFetch({ nav: () => ({ json: { code: 0, data: {} } }) })
  await assert.rejects(() => fetchIt(noImg), e => /wbi_img/.test(e.message))
})

test('fetch 本身抛（DNS 断）原样上抛，由 pool 分类', async () => {
  await withHome(test)
  clearWbiCache()
  await assert.rejects(
    () => biliAdapter.fetch(source, { now: () => NOW, fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    TypeError
  )
  clearWbiCache()
})

/* ───────────────────────── fetchBiliSubtitle：baleen.subtitle 工具的后端 ─── */

test('fetchBiliSubtitle：view 拿 cid → player/wbi/v2 签名请求 → 字幕 json 拼全文', async () => {
  await withHome(test, { cookie: true })
  const fetchImpl = fakeFetch(defaultHandlers())
  const text = await subFetch(fetchImpl)
  assert.equal(text, '大家好\n今天讲适配器。')
  const player = fetchImpl.state.calls.find(c => c.url.includes('player/wbi/v2'))
  const u = new URL(player.url)
  assert.equal(u.searchParams.get('bvid'), 'BV1xx411c7mD')
  assert.equal(u.searchParams.get('cid'), '1001')
  assert.ok(u.searchParams.get('w_rid'))
  assert.equal(player.headers.Cookie, 'SESSDATA=fake-value; bili_jct=fake')
})

test('fetchBiliSubtitle：无 cookie 匿名照跑（CC 字幕匿名可能拿得到）→ 不再拦 credentials_missing，请求不带 Cookie 头', async () => {
  await withHome(test)
  const logs = []
  const anon = fakeFetch(defaultHandlers()) // player 桩照样回字幕：匿名能拿到就照给
  const text = await subFetch(anon, { log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(text, '大家好\n今天讲适配器。')
  assert.equal(anon.state.calls.some(c => c.headers.Cookie), false)
  assert.ok(logs.some(l => l.event === 'bili_subtitle_need_login' && l.detail.includes('BV1xx411c7mD')),
    '无凭据留一行 need_login 诊断（提示字幕增强未启用）')
})

test('fetchBiliSubtitle：匿名 player 字幕列表为空 → 空串（no_subtitle 由调用方裁定）', async () => {
  await withHome(test)
  const logs = []
  const none = fakeFetch(defaultHandlers({ player: () => ({ json: PLAYER([]) }) }))
  const text = await subFetch(none, { log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(text, '')
  assert.ok(logs.some(l => l.event === 'bili_subtitle_need_login' && l.detail.includes('BV1xx411c7mD')))
})

test('fetchBiliSubtitle：412 原样上浮；bvid 空 bad_source 零请求', async () => {
  await withHome(test)
  const risk = fakeFetch(defaultHandlers({ view: () => ({ status: 412 }) }))
  await assert.rejects(() => subFetch(risk), e => e.status === 412)

  const noBvid = fakeFetch(defaultHandlers())
  await assert.rejects(
    () => fetchBiliSubtitle('   ', { fetchImpl: noBvid }),
    e => e.error_class === 'bad_source'
  )
  assert.equal(noBvid.state.calls.length, 0)
})

/* ───────────────────────── 注册与工具函数 ───────────────────────── */

test('adapterFor 注册 bili；parseSpaceUid/parseLength 按契约解析', () => {
  assert.equal(adapterFor('bili'), ADAPTERS.bili)
  assert.equal(adapterFor('Bili'), ADAPTERS.bili)
  assert.equal(adapterFor('xhs'), null)

  assert.equal(parseSpaceUid('https://space.bilibili.com/946974'), '946974')
  assert.equal(parseSpaceUid('https://space.bilibili.com/946974?spm_id_from=x'), '946974')
  assert.equal(parseSpaceUid('https://www.bilibili.com/video/BV1x'), null)
  assert.equal(parseSpaceUid(null), null)

  assert.equal(parseLength('12:34'), 754)
  assert.equal(parseLength('1:02:03'), 3723)
  assert.equal(parseLength(''), null)
  assert.equal(parseLength(null), null)
})
