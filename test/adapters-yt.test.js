import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ytAdapter, adapterFor, ADAPTERS } from '../lib/adapters/index.js'
import { fetchYt, pickCaptionTrack, uploadDateMs } from '../lib/adapters/yt.js'
import { parseJson3, parseVtt } from '../lib/adapters/yt-captions.js'
import { inferBodyState } from '../lib/normalize.js'

const CH_URL = 'https://www.youtube.com/@somechannel/videos'
const source = { id: 'yt-a', type: 'yt', url: CH_URL, label: '某频道' }
const NOW = 1730000000000

/* ───────────────────────── 夹具：flat 列表与单视频 dump 的实测形态 ──────────
 * 结构照计划"本机实测"段：flat 是 { entries: [{ id, title }] }；
 * 单视频 dump 是 { duration, upload_date, subtitles/automatic_captions 的
 * { <lang>: [{ ext, url }] }（json3|vtt）, description, thumbnail }。 */

const ENTRIES = [
  { id: 'vidA1111111', title: '第一期：适配器与字幕' },
  { id: 'vidB2222222', title: '第二期：只有自动字幕' },
  { id: 'vidC3333333', title: '第三期：没有字幕' },
  { id: 'vidD4444444', title: '第四期：啥都没有' }
]
const FLAT = () => ({ entries: ENTRIES.map(e => ({ ...e })) })

const trk = (name, ext) => ({ ext, url: `https://captions.test/${name}.${ext}` })

const DETAIL = (id) => {
  const base = { id, uploader: '某频道' }
  if (id === 'vidA1111111') return {
    ...base, title: '第一期：适配器与字幕', duration: 754, upload_date: '20261024',
    description: '这期讲适配器怎么写', thumbnail: 'https://i.ytimg.com/vi/vidA1111111/hqdefault.jpg',
    subtitles: { en: [trk('a-en', 'vtt')], 'zh-Hans': [trk('a-zh', 'json3')] }, automatic_captions: {}
  }
  if (id === 'vidB2222222') return {
    ...base, title: '第二期：只有自动字幕', duration: 300, upload_date: '20261023',
    description: '自动字幕的一期', thumbnail: 'https://i.ytimg.com/vi/vidB2222222/hqdefault.jpg',
    subtitles: {}, automatic_captions: { en: [trk('b-auto-en', 'json3')], 'zh-Hans': [trk('b-auto-zh', 'json3')] }
  }
  if (id === 'vidC3333333') return {
    ...base, title: '第三期：没有字幕', duration: 120, upload_date: '20261022',
    description: '纯画面演示', thumbnail: 'https://i.ytimg.com/vi/vidC3333333/hqdefault.jpg',
    subtitles: {}, automatic_captions: {}
  }
  return {
    ...base, title: '第四期：啥都没有', duration: 60, upload_date: '20261021',
    description: '', thumbnail: 'https://i.ytimg.com/vi/vidD4444444/hqdefault.jpg',
    subtitles: {}, automatic_captions: {}
  }
}

const JSON3 = (lines = ['大家好', '第一期正文']) => JSON.stringify({
  events: [
    ...lines.map((t, i) => ({ tStartMs: i * 2500, dDurationMs: 2000, segs: [{ utf8: t }, { utf8: '\n' }] })),
    { tStartMs: 0, dDurationMs: 999 } // 无 segs 的纯时间事件：必须跳过
  ]
})

const VTT = () => [
  'WEBVTT',
  'Kind: captions',
  'Language: zh-Hans',
  '',
  'cue-1',
  '00:00:00.000 --> 00:00:02.000',
  '大家好',
  '',
  '00:00:02.000 --> 00:00:04.000',
  '<v Roger>讲 <c.yellow>yt-dlp</c> 的字幕 &amp; 实体',
  '',
  'NOTE 这行是注释',
  '注释第二行也不算正文',
  '',
  '00:00:05.000 --> 00:00:06.000',
  '第三行',
  '第三行',
  ''
].join('\n')

/* ───────────────────────── 桩：spawnImpl（帧脚本化，手法照 957b811）+ fetchImpl ── */

const videoIdFrom = (url) => {
  const s = String(url)
  return /watch\?v=([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? /youtu\.be\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? ''
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let killed = false
  child.kill = () => {
    if (killed) return true
    killed = true
    // 真机 kill → exit 十几毫秒内到；桩下个 tick 模拟（SIGTERM 形态，exit code null）
    process.nextTick(() => { child.exitCode = null; child.emit('exit', null, 'SIGTERM') })
    return true
  }
  child.isKilled = () => killed
  return child
}

/**
 * 可脚本化的 spawn 桩。handlers.flat({ url, args }) / handlers.detail({ url, args }) 回：
 *   { json }（stdout=JSON、退出 0）| { stdout, stderr, exit }（自定义帧与退出码）
 *   { error: 'ENOENT' }（error 事件）| { hang: true }（永不退出，abort/硬超时测试用）。
 * 也可以回 Promise（并发与乱序完成测试里控制时机）。帧都异步发（微任务），
 * 适配器同步挂监听的时序才成立。
 */
function fakeSpawn(handlers = {}) {
  const state = { spawns: [], children: [] }
  const spawnImpl = (cmd, args) => {
    state.spawns.push({ cmd, args: [...args] })
    const child = fakeChild()
    state.children.push(child)
    const url = args[args.length - 1]
    const route = args.includes('--flat-playlist')
      ? handlers.flat?.({ url, args }) ?? { json: FLAT() }
      : handlers.detail?.({ url, args }) ?? { json: DETAIL(videoIdFrom(url)) }
    Promise.resolve(route).then(r => {
      if (!r || r.hang) return
      if (r.error != null) {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: r.error }))
        return
      }
      const stdout = r.stdout != null ? r.stdout : (r.json != null ? JSON.stringify(r.json) : '')
      const stderr = r.stderr != null ? r.stderr : ''
      if (stdout) child.stdout.emit('data', stdout)
      if (stderr) child.stderr.emit('data', stderr)
      child.exitCode = r.exit ?? 0
      child.emit('exit', child.exitCode)
    })
    return child
  }
  spawnImpl.state = state
  return spawnImpl
}

/** 字幕轨 fetch 桩：URL 精确路由到 { text }（200）或 { status }（非 2xx）。 */
function captionFetch(routes = {}) {
  const state = { calls: [] }
  const impl = async (url, init = {}) => {
    state.calls.push({ url: String(url), signal: init?.signal })
    const r = routes[String(url)]
    if (!r) throw new TypeError(`stub: 未配置的字幕 URL ${url}`)
    if (r.status != null) return { ok: false, status: r.status, text: async () => '' }
    return { ok: true, status: 200, text: async () => r.text }
  }
  impl.state = state
  return impl
}

const CAPTION_ROUTES = () => ({
  'https://captions.test/a-zh.json3': { text: JSON3(['大家好', '第一期正文']) },
  'https://captions.test/a-en.vtt': { text: VTT() },
  'https://captions.test/b-auto-zh.json3': { text: JSON3(['自动字幕中文']) },
  'https://captions.test/b-auto-en.json3': { text: JSON3(['auto en text']) }
})

const fetchYtIt = (spawnImpl, over = {}) =>
  ytAdapter.fetch(source, { since: null, now: () => NOW, fetchImpl: captionFetch(CAPTION_ROUTES()), ...over, spawnImpl })

/* ───────────────────────── 字幕轨解析器（纯函数） ───────────────────────── */

test('parseJson3：events[].segs[].utf8 逐段拼接，无 segs 的时间事件跳过，换行 seg 归整成行', () => {
  assert.equal(parseJson3(JSON3(['大家好', '第一期正文'])), '大家好\n第一期正文')
  assert.equal(
    parseJson3(JSON.stringify({ events: [{ segs: [{ utf8: 'Hel' }, { utf8: 'lo ' }, { utf8: 'wor' }, { utf8: 'ld' }, { utf8: '\n' }] }] })),
    'Hello world'
  )
  assert.equal(parseJson3('{"events":[]}'), '')
  assert.equal(parseJson3('not json'), '')
  assert.equal(parseJson3(''), '')
  assert.equal(parseJson3(null), '')
})

test('parseVtt：去头部/cue 标识行/时间轴/行内标签/NOTE 块，解码实体，滚动重复行去重', () => {
  assert.equal(parseVtt(VTT()), '大家好\n讲 yt-dlp 的字幕 & 实体\n第三行')
  assert.equal(
    parseVtt(['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', 'A &lt;b&gt; &quot;x&quot; &#39;y&#39; &nbsp;&amp;&nbsp; Z', ''].join('\n')),
    'A <b> "x" \'y\'  &  Z'
  )
  assert.equal(parseVtt(''), '')
  assert.equal(parseVtt(null), '')
})

test('uploadDateMs：YYYYMMDD → UTC 毫秒；形态坏/月日越界 → null', () => {
  assert.equal(uploadDateMs('20261024'), Date.UTC(2026, 9, 24))
  assert.equal(uploadDateMs('20260101'), Date.UTC(2026, 0, 1))
  assert.equal(uploadDateMs('20261301'), null, '月 13 滚到下年不算合法')
  assert.equal(uploadDateMs('20261032'), null, '日 32 滚到下月不算合法')
  assert.equal(uploadDateMs('2026102'), null)
  assert.equal(uploadDateMs(''), null)
  assert.equal(uploadDateMs(null), null)
})

/* ───────────────────────── 字幕轨挑选 ───────────────────────── */

test('字幕优先级（计划 Task 1）：manual zh > manual en > auto zh > auto en；组内 json3 优先、vtt 兜底', () => {
  assert.equal(pickCaptionTrack({ subtitles: { en: [trk('e', 'json3')], 'zh-Hans': [trk('z', 'json3')] }, automatic_captions: {} })?.url, 'https://captions.test/z.json3')
  assert.equal(pickCaptionTrack({ subtitles: { 'zh-Hant': [trk('zt', 'vtt')] }, automatic_captions: { 'zh-Hans': [trk('az', 'json3')] } })?.url, 'https://captions.test/zt.vtt', 'manual zh（含繁体）胜 auto zh')
  assert.equal(pickCaptionTrack({ subtitles: { en: [trk('e', 'json3')] }, automatic_captions: { 'zh-Hans': [trk('az', 'json3')] } })?.url, 'https://captions.test/e.json3', 'manual en 胜 auto zh')
  assert.equal(pickCaptionTrack({ subtitles: {}, automatic_captions: { en: [trk('ae', 'json3')], 'zh-Hans': [trk('azh', 'json3')] } })?.url, 'https://captions.test/azh.json3', 'auto zh 胜 auto en')
  assert.equal(pickCaptionTrack({ subtitles: {}, automatic_captions: { en: [trk('ae', 'vtt')] } })?.url, 'https://captions.test/ae.vtt', '只有 auto en 也认')
  assert.equal(pickCaptionTrack({ subtitles: { en: [trk('e-v', 'vtt'), trk('e-j', 'json3')] } })?.ext, 'json3', '同轨组 json3 优先')
  assert.equal(pickCaptionTrack({ subtitles: { en: [trk('e-v', 'vtt')] } })?.ext, 'vtt')
  assert.equal(pickCaptionTrack({}), null)
  assert.equal(pickCaptionTrack(null), null)
})

/* ───────────────────────── flat → RawItem 全链 ───────────────────────── */

test('flat-playlist → RawItem：4 条按列表序；external_id=id、url=watch、duration/upload_date/thumb 如实翻译', async () => {
  const spawnImpl = fakeSpawn()
  const items = await fetchYtIt(spawnImpl)
  assert.equal(spawnImpl.state.spawns.length, 5, '1 次 flat + 4 次单视频 dump')
  assert.equal(items.length, 4)
  assert.deepEqual(items.map(x => x.external_id), ENTRIES.map(e => e.id), '输出序与列表序一致（runner 按序对账）')
  const a = items[0]
  assert.equal(a.source_id, 'yt-a')
  assert.equal(a.source_type, 'yt')
  assert.equal(a.external_id, 'vidA1111111')
  assert.equal(a.url, 'https://www.youtube.com/watch?v=vidA1111111')
  assert.equal(a.title, '第一期：适配器与字幕')
  assert.equal(a.author, '某频道')
  assert.equal(a.duration_sec, 754)
  assert.equal(a.published_at, Date.UTC(2026, 9, 24))
  assert.equal(a.thumb, 'https://i.ytimg.com/vi/vidA1111111/hqdefault.jpg')
  assert.equal(a.fetched_at, NOW)
  assert.equal(a.tags, null)
  assert.equal(a.locale, null)
})

test('spawn 参数逐字对齐实测命令：flat 带 --flat-playlist --playlist-items 30，单视频带 --dump-single-json', async () => {
  const spawnImpl = fakeSpawn()
  await fetchYtIt(spawnImpl)
  assert.equal(spawnImpl.state.spawns[0].cmd, 'yt-dlp')
  assert.deepEqual(spawnImpl.state.spawns[0].args, ['--dump-single-json', '--flat-playlist', '--playlist-items', '30', CH_URL])
  assert.deepEqual(spawnImpl.state.spawns[1].args, ['--dump-single-json', 'https://www.youtube.com/watch?v=vidA1111111'])
})

test('body_state 三态（语义照计划逐字）：拿到字幕轨文本=subtitle；无字幕 description 非空=summary_only；都空=missing', async () => {
  const fetchImpl = captionFetch(CAPTION_ROUTES())
  const items = await fetchYtIt(fakeSpawn(), { fetchImpl })
  const [a, b, c, d] = items
  // manual zh-Hans 胜 manual en：拉的是 a-zh 那条
  assert.equal(a.subtitle_text, '大家好\n第一期正文')
  assert.equal(a.body_html, '这期讲适配器怎么写\n\n大家好\n第一期正文')
  assert.equal(inferBodyState(a), 'subtitle')
  // auto zh-Hans 胜 auto en：拉的是 b-auto-zh 那条
  assert.equal(b.subtitle_text, '自动字幕中文')
  assert.equal(inferBodyState(b), 'subtitle', 'auto captions 是平台 ASR，形态就是字幕轨，同 subtitle（与 bili 的 AI 字幕同待遇）')
  const gotUrls = fetchImpl.state.calls.map(x => x.url)
  assert.ok(gotUrls.includes('https://captions.test/a-zh.json3') && !gotUrls.includes('https://captions.test/a-en.vtt'))
  assert.ok(gotUrls.includes('https://captions.test/b-auto-zh.json3') && !gotUrls.includes('https://captions.test/b-auto-en.json3'))
  assert.equal(c.subtitle_text, undefined)
  assert.equal(c.body_html, '纯画面演示')
  assert.equal(inferBodyState(c), 'summary_only', '无字幕但简介非空 → summary_only 进候选，不能全被预筛丢')
  assert.equal(d.body_html, null)
  assert.equal(d.subtitle_text, undefined)
  assert.equal(inferBodyState(d), 'missing')
})

test('vtt 兜底：该语言轨只有 vtt 时用极简解析器出全文', async () => {
  const only = { entries: [ENTRIES[0]] }
  const fetchImpl = captionFetch({ 'https://captions.test/a-zh.vtt': { text: VTT() } })
  const spawnImpl = fakeSpawn({
    flat: () => ({ json: only }),
    detail: ({ url }) => ({ json: { ...DETAIL('vidA1111111'), subtitles: { 'zh-Hans': [trk('a-zh', 'vtt')] } } })
  })
  const [a] = await fetchYtIt(spawnImpl, { fetchImpl })
  assert.equal(a.subtitle_text, '大家好\n讲 yt-dlp 的字幕 & 实体\n第三行')
})

test('since 不过滤（增量判定交给 putDraft 去重、backlog 交给 gate）：所有条目照常返回', async () => {
  const items = await fetchYtIt(fakeSpawn(), { since: 4102444800000 })
  assert.equal(items.length, 4)
})

/* ───────────────────────── 预算与取消 ───────────────────────── */

test('外层 abort：并发 3 下在飞的 3 个 dump 子进程全部被 kill、第 4 个不再发起（孤儿调用消失）', async () => {
  const vids = Array.from({ length: 8 }, (_, i) => ({ id: `ord${String(i).padStart(8, '0')}`, title: `第${i}期` }))
  const spawnImpl = fakeSpawn({
    flat: () => ({ json: { entries: vids } }),
    detail: () => ({ hang: true })
  })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20)
  try {
    await assert.rejects(() => fetchYtIt(spawnImpl, { signal: ac.signal }), e => e.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
  const detailSpawns = spawnImpl.state.spawns.filter(s => !s.args.includes('--flat-playlist'))
  assert.equal(detailSpawns.length, 3, `abort 时只该有首波 3 条在飞（实际 ${detailSpawns.length}）`)
  assert.equal(spawnImpl.state.children.filter(c => c.isKilled()).length, 3, '每个在飞子进程都必须被 kill（不留孤儿）')
})

test('子进程硬超时（防 yt-dlp 挂死）：注入 childTimeoutMs 40ms → TimeoutError 上抛、子进程被 kill', async () => {
  const spawnImpl = fakeSpawn({ flat: () => ({ hang: true }) })
  await assert.rejects(
    () => fetchYtIt(spawnImpl, { childTimeoutMs: 40 }),
    e => e.name === 'TimeoutError' && /yt-dlp/.test(e.message)
  )
  assert.equal(spawnImpl.state.children[0].isKilled(), true)
})

test('单视频 dump 受限并发 3 保持顺序：在飞峰值恰 3，乱序完成输出仍按列表序', async () => {
  const vids = Array.from({ length: 8 }, (_, i) => ({ id: `ord${String(i).padStart(8, '0')}`, title: `第${i}期` }))
  const delays = [200, 170, 140, 110, 80, 50, 30, 10] // 越靠后越快回：完成序与输入序相反
  let inFlight = 0
  let maxInFlight = 0
  const spawnImpl = fakeSpawn({
    flat: () => ({ json: { entries: vids } }),
    detail: ({ url }) => {
      const i = Number(videoIdFrom(url).slice(-1))
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise(resolve => setTimeout(() => {
        inFlight--
        resolve({ json: { id: vids[i].id, title: `第${i}期`, duration: 300, upload_date: '20261020', description: `简介${i}`, uploader: '某频道', subtitles: {}, automatic_captions: {} } })
      }, delays[i]))
    }
  })
  const items = await fetchYtIt(spawnImpl)
  assert.equal(items.length, 8)
  assert.deepEqual(items.map(x => x.external_id), vids.map(v => v.id), '输出顺序必须与输入顺序一致')
  assert.equal(maxInFlight, 3, `dump 并发上限应为 3（实测在飞峰值 ${maxInFlight}）`)
})

test('字幕请求带合并信号：外层 abort 时在飞的字幕 fetch 被掐断（AbortSignal.any 与 5s 预算竞速）', async () => {
  const ac = new AbortController()
  const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  let abortSeen = 0
  const fetchImpl = async (url, init = {}) => new Promise((_, reject) => {
    if (init.signal?.aborted) { abortSeen++; return reject(abortErr()) }
    init.signal?.addEventListener('abort', () => { abortSeen++; reject(abortErr()) })
  })
  const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: [ENTRIES[0]] } }) })
  const timer = setTimeout(() => ac.abort(), 25)
  try {
    await assert.rejects(() => fetchYtIt(spawnImpl, { fetchImpl, signal: ac.signal }), e => e.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
  assert.equal(abortSeen, 1, '在飞的字幕 fetch 必须收到 abort')
})

test('字幕 5s 预算超时形态（TimeoutError）→ 单条降级 summary_only + 恰一行 yt_subtitle_slow', async () => {
  const logs = []
  const fetchImpl = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }
  const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: [ENTRIES[0]] } }) })
  const [a] = await fetchYtIt(spawnImpl, { fetchImpl, log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(a.subtitle_text, undefined, '预算内没拿到就按无字幕')
  assert.equal(a.body_html, '这期讲适配器怎么写', '简介非空 → summary_only（下一轮照常走增量判断）')
  assert.equal(logs.filter(l => l.event === 'yt_subtitle_slow').length, 1, '慢字幕诊断只记一次不刷屏')
})

test('字幕下载失败（HTTP 500）→ 单条降级 summary_only + 一行 yt_subtitle_failed；请求带合并 signal', async () => {
  const logs = []
  const fetchImpl = captionFetch({ ...CAPTION_ROUTES(), 'https://captions.test/a-zh.json3': { status: 500 } })
  const [a] = await fetchYtIt(fakeSpawn(), { fetchImpl, log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(a.subtitle_text, undefined)
  assert.equal(a.body_html, '这期讲适配器怎么写')
  const slow = logs.filter(l => l.event === 'yt_subtitle_failed')
  assert.equal(slow.length, 1)
  assert.ok(slow[0].detail.includes('vidA1111111'))
  assert.ok(fetchImpl.state.calls[0].signal instanceof AbortSignal, '字幕 fetch 必须带合并预算信号')
})

/* ───────────────────────── 错误映射 ───────────────────────── */

test('yt-dlp 不存在（spawn ENOENT）→ error_class=unavailable，消息指路 yt_dlp_path，零字幕请求', async () => {
  const fetchImpl = captionFetch(CAPTION_ROUTES())
  await assert.rejects(
    () => fetchYtIt(fakeSpawn({ flat: () => ({ error: 'ENOENT' }) }), { fetchImpl }),
    e => e.error_class === 'unavailable' && /yt_dlp_path/.test(e.message)
  )
  assert.equal(fetchImpl.state.calls.length, 0)
})

test('flat-playlist 非零退出 → parse 分类，尾行（stderr 优先）截断 120 字进诊断', async () => {
  const long = 'ERROR: ' + 'x'.repeat(300)
  await assert.rejects(
    () => fetchYtIt(fakeSpawn({ flat: () => ({ exit: 1, stderr: `WARNING: something\n${long}\n` }) })),
    e => {
      assert.equal(e.parse, true)
      assert.match(e.message, /退出码 1/)
      assert.ok(e.message.includes('x'.repeat(113)) && !e.message.includes('x'.repeat(114)), '尾行截断 120')
      return true
    }
  )
})

test('flat-playlist 层失败：空 entries → empty；stdout 非 JSON / 空输出 → parse', async () => {
  await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ json: { entries: [] } }) })), e => e.empty === true)
  await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ stdout: 'not-json', exit: 0 }) })), e => e.parse === true)
  await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ stdout: '', exit: 0 }) })), e => e.parse === true)
})

test('单视频 dump 失败（私享/删档视频）不拖垮整源：该条降级 missing（列表 title 兜底）+ 诊断一行，其余照常', async () => {
  const logs = []
  const spawnImpl = fakeSpawn({
    detail: ({ url }) => videoIdFrom(url) === 'vidA1111111'
      ? { exit: 1, stderr: 'ERROR: [youtube] vidA1111111: Private video' }
      : { json: DETAIL(videoIdFrom(url)) }
  })
  const items = await fetchYtIt(spawnImpl, { log: (event, detail) => logs.push({ event, detail }) })
  assert.equal(items.length, 4)
  const [a, b] = items
  assert.equal(a.external_id, 'vidA1111111')
  assert.equal(a.title, '第一期：适配器与字幕', '列表 title 兜底')
  assert.equal(a.duration_sec, null)
  assert.equal(a.published_at, null)
  assert.equal(a.body_html, null)
  assert.equal(inferBodyState(a), 'missing')
  assert.equal(b.subtitle_text, '自动字幕中文', '其余条目照常')
  assert.ok(logs.some(l => l.event === 'yt_detail_failed' && l.detail.includes('vidA1111111') && l.detail.includes('Private video')))
})

test('源 url 缺失/非 http(s) → error_class=bad_source，零 spawn', async () => {
  const spawnImpl = fakeSpawn()
  await assert.rejects(
    () => ytAdapter.fetch({ id: 'b', type: 'yt', url: 'ftp://x/y' }, { spawnImpl }),
    e => e.error_class === 'bad_source'
  )
  await assert.rejects(
    () => ytAdapter.fetch({ id: 'b', type: 'yt', url: '' }, { spawnImpl }),
    e => e.error_class === 'bad_source'
  )
  assert.equal(spawnImpl.state.spawns.length, 0)
})

/* ───────────────────────── 偏好键 ───────────────────────── */

test('--proxy 传参：network.proxy 设置时每个 yt-dlp 调用都带 --proxy <值>；yt_dlp_path 覆盖可执行名；未设置时绝不出现', async () => {
  const spawnImpl = fakeSpawn()
  await fetchYtIt(spawnImpl, { pref: { yt_dlp_path: 'D:/tools/yt-dlp.exe', network: { proxy: 'http://127.0.0.1:7890' } } })
  assert.equal(spawnImpl.state.spawns[0].cmd, 'D:/tools/yt-dlp.exe')
  for (const s of spawnImpl.state.spawns) {
    const i = s.args.indexOf('--proxy')
    assert.ok(i >= 0, '缺 --proxy')
    assert.equal(s.args[i + 1], 'http://127.0.0.1:7890')
  }
  const plain = fakeSpawn()
  await fetchYtIt(plain)
  assert.equal(spawnImpl.state.spawns.length, 5)
  assert.ok(plain.state.spawns.every(s => !s.args.includes('--proxy')), '未设置代理时一个 --proxy 都不该有')
  assert.equal(plain.state.spawns[0].cmd, 'yt-dlp', '缺省 yt-dlp 走 PATH')
})

/* ───────────────────────── 注册 ───────────────────────── */

test('adapterFor 注册 yt', () => {
  assert.equal(adapterFor('yt'), ADAPTERS.yt)
  assert.equal(adapterFor('YT'), ADAPTERS.yt)
  assert.equal(adapterFor('weibo'), null)
})

test('fetchYt 与 ytAdapter.fetch 是同一入口（runner 经注册表调它）', () => {
  assert.equal(ytAdapter.fetch, fetchYt)
})

/* ───────────────────────── 单视频源（真机实测：flat 对 watch URL 回视频自身 JSON，无 entries） ── */

test('单视频源（watch?v= / youtu.be）：跳过 flat、直接一次 dump-single-json，产物照常三态', async () => {
  const watch = 'https://www.youtube.com/watch?v=vidA1111111'
  const spawnImpl = fakeSpawn({ detail: ({ url }) => ({ json: DETAIL(videoIdFrom(url)) }) })
  const items = await ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: watch }, {
    since: null, now: () => NOW, fetchImpl: captionFetch(CAPTION_ROUTES()), spawnImpl
  })
  assert.equal(spawnImpl.state.spawns.length, 1, '单视频源只该有一次 spawn（无 flat）')
  assert.deepEqual(spawnImpl.state.spawns[0].args, ['--dump-single-json', watch])
  assert.equal(items.length, 1)
  assert.equal(items[0].external_id, 'vidA1111111')
  assert.equal(items[0].subtitle_text, '大家好\n第一期正文')
  assert.equal(items[0].duration_sec, 754)

  const bare = fakeSpawn({ detail: ({ url }) => ({ json: DETAIL(videoIdFrom(url)) }) })
  const items2 = await ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: 'https://youtu.be/vidC3333333?t=30' }, {
    since: null, now: () => NOW, fetchImpl: captionFetch(CAPTION_ROUTES()), spawnImpl: bare
  })
  assert.equal(bare.state.spawns.length, 1)
  assert.equal(items2[0].external_id, 'vidC3333333', 'youtu.be 短链也认')
  assert.equal(items2[0].body_html, '纯画面演示', '无字幕单视频 → summary_only')
})

test('单视频源 dump 失败 → 整源失败上抛（没有列表可兜底，不产假 missing、游标不推进）', async () => {
  const spawnImpl = fakeSpawn({ detail: () => ({ exit: 1, stderr: 'ERROR: [youtube] vidA1111111: Video unavailable' }) })
  await assert.rejects(
    () => ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: 'https://www.youtube.com/watch?v=vidA1111111' }, {
      since: null, now: () => NOW, fetchImpl: captionFetch(CAPTION_ROUTES()), spawnImpl
    }),
    e => e.parse === true && /Video unavailable/.test(e.message)
  )
})
