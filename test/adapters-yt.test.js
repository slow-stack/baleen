import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ytAdapter, adapterFor, ADAPTERS } from '../lib/adapters/index.js'
import { fetchYt, uploadDateMs } from '../lib/adapters/yt.js'
import { parseJson3, parseVtt } from '../lib/adapters/yt-captions.js'
import { inferBodyState } from '../lib/normalize.js'

const CH_URL = 'https://www.youtube.com/@somechannel/videos'
const source = { id: 'yt-a', type: 'yt', url: CH_URL, label: '某频道' }
const NOW = 1730000000000

/* ───────────────────────── 夹具：flat 列表与单视频 dump 的实测形态 ──────────
 * 结构照计划"本机实测"段：flat 是 { entries: [{ id, title }] }；
 * 单视频 dump 是 { duration, upload_date, description, thumbnail }。
 * 字幕不再从 dump 的 subtitles/automatic_captions 里选轨 fetch（Task 1b 起废弃），
 * 而是独立的 yt-dlp 落盘调用（--write-auto-subs …）后按文件优先级挑选。 */

const ENTRIES = [
  { id: 'vidA1111111', title: '第一期：适配器与字幕' },
  { id: 'vidB2222222', title: '第二期：只有自动字幕' },
  { id: 'vidC3333333', title: '第三期：没有字幕' },
  { id: 'vidD4444444', title: '第四期：啥都没有' }
]
const FLAT = () => ({ entries: ENTRIES.map(e => ({ ...e })) })

const DETAIL = (id) => {
  const base = { id, uploader: '某频道' }
  if (id === 'vidA1111111') return {
    ...base, title: '第一期：适配器与字幕', duration: 754, upload_date: '20261024',
    description: '这期讲适配器怎么写', thumbnail: 'https://i.ytimg.com/vi/vidA1111111/hqdefault.jpg'
  }
  if (id === 'vidB2222222') return {
    ...base, title: '第二期：只有自动字幕', duration: 300, upload_date: '20261023',
    description: '自动字幕的一期', thumbnail: 'https://i.ytimg.com/vi/vidB2222222/hqdefault.jpg'
  }
  if (id === 'vidC3333333') return {
    ...base, title: '第三期：没有字幕', duration: 120, upload_date: '20261022',
    description: '纯画面演示', thumbnail: 'https://i.ytimg.com/vi/vidC3333333/hqdefault.jpg'
  }
  return {
    ...base, title: '第四期：啥都没有', duration: 60, upload_date: '20261021',
    description: '', thumbnail: 'https://i.ytimg.com/vi/vidD4444444/hqdefault.jpg'
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

/* ───────────────────────── 桩：spawnImpl（帧脚本化，手法照 957b811）────────
 * 三类调用按参数分流（真 yt-dlp 的判别特征）：
 *   flat   = --flat-playlist（列表）；detail = --dump-single-json（单视频元数据）；
 *   subs   = --write-auto-subs（字幕落盘）。subs 桩照真机探针行为模拟 yt-dlp 写文件：
 *   { files: [{lang, ext, text}] } 先把 <id>.<lang>.<ext> 写进 -o 目录再退出，
 *   与 exit/stderr 组合可演出"zh 429 但 en 已落盘"等真机形态。 */

const videoIdFrom = (url) => {
  const s = String(url)
  return /watch\?v=([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? /youtu\.be\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? ''
}

/** 缺省字幕落盘表：A/B 有 zh-Hans 轨（manual/auto 之分在文件层不可见，也不必可见），C/D 无轨。 */
const SUB_FILES = {
  vidA1111111: [{ lang: 'zh-Hans', ext: 'json3', text: JSON3(['大家好', '第一期正文']) }],
  vidB2222222: [{ lang: 'zh-Hans', ext: 'json3', text: JSON3(['自动字幕中文']) }],
  vidC3333333: [],
  vidD4444444: []
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

function writeSubFiles(args, url, files) {
  const tpl = args[args.indexOf('-o') + 1]
  const dir = path.dirname(tpl)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(dir, `${videoIdFrom(url)}.${f.lang}.${f.ext}`), f.text)
}

/**
 * 可脚本化的 spawn 桩。handlers.flat/detail/subs 的 ({ url, args }) 回：
 *   { json }（stdout=JSON、退出 0）| { stdout, stderr, exit }（自定义帧与退出码）
 *   { files: [{lang, ext, text}] }（subs 专用：先落盘再退出；可与 exit/stderr 组合）
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
    const kind = args.includes('--flat-playlist') ? 'flat'
      : args.includes('--write-auto-subs') ? 'subs'
        : 'detail'
    const fallback = kind === 'flat' ? { json: FLAT() }
      : kind === 'subs' ? { files: SUB_FILES[videoIdFrom(url)] ?? [] }
        : { json: DETAIL(videoIdFrom(url)) }
    const route = handlers[kind]?.({ url, args }) ?? fallback
    Promise.resolve(route).then(r => {
      if (!r || r.hang) return
      if (r.error != null) {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: r.error }))
        return
      }
      if (Array.isArray(r.files)) writeSubFiles(args, url, r.files)
      const stdout = r.stdout != null ? r.stdout : (r.json != null ? JSON.stringify(r.json) : 'ok')
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

/** 每个测试一块独立的字幕落盘根目录，跑完连根删掉（不碰真 home）。 */
async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-yt-test-'))
  try { return await fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

const fetchYtIt = (spawnImpl, subsRoot, over = {}) =>
  ytAdapter.fetch(source, { since: null, now: () => NOW, subsRoot, ...over, spawnImpl })

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

/* ───────────────────────── flat → RawItem 全链 ───────────────────────── */

test('flat-playlist → RawItem：4 条按列表序；external_id=id、url=watch、duration/upload_date/thumb 如实翻译', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn()
    const items = await fetchYtIt(spawnImpl, subsRoot)
    assert.equal(spawnImpl.state.spawns.length, 9, '1 次 flat + 每条视频 2 次（dump + 字幕落盘）')
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
})

test('spawn 参数逐字对齐：flat 带 --flat-playlist，dump 带 --dump-single-json，字幕调用带 --write-auto-subs 全语言表', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn()
    await fetchYtIt(spawnImpl, subsRoot)
    assert.equal(spawnImpl.state.spawns[0].cmd, 'yt-dlp')
    assert.deepEqual(spawnImpl.state.spawns[0].args, ['--retries', '1', '--extractor-retries', '1', '--dump-single-json', '--flat-playlist', '--playlist-items', '30', CH_URL])
    assert.deepEqual(spawnImpl.state.spawns[1].args, ['--retries', '1', '--extractor-retries', '1', '--dump-single-json', 'https://www.youtube.com/watch?v=vidA1111111'])
    const subSpawn = spawnImpl.state.spawns.find(
      s => s.args.includes('--write-auto-subs') && s.args.at(-1) === 'https://www.youtube.com/watch?v=vidA1111111'
    )
    assert.ok(subSpawn, 'vidA 必须有一次字幕落盘调用')
    assert.deepEqual(subSpawn.args, [
      '--retries', '1', '--extractor-retries', '1',
      '--skip-download', '--write-subs', '--write-auto-subs', '--ignore-errors',
      '--sub-langs', 'zh-Hans,zh-Hant,zh,en-orig,en',
      '--sub-format', 'json3/vtt',
      '-o', path.join(subsRoot, 'vidA1111111', '%(id)s.%(ext)s'),
      'https://www.youtube.com/watch?v=vidA1111111'
    ])
  })
})

test('body_state 三态（语义照计划逐字）：拿到字幕文本=subtitle；无字幕 description 非空=summary_only；都空=missing', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const items = await fetchYtIt(fakeSpawn(), subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    const [a, b, c, d] = items
    assert.equal(a.subtitle_text, '大家好\n第一期正文')
    assert.equal(a.body_html, '这期讲适配器怎么写\n\n大家好\n第一期正文')
    assert.equal(inferBodyState(a), 'subtitle')
    assert.equal(b.subtitle_text, '自动字幕中文')
    assert.equal(inferBodyState(b), 'subtitle', 'auto captions 是平台 ASR，形态就是字幕轨，同 subtitle（与 bili 的 AI 字幕同待遇）')
    assert.equal(c.subtitle_text, undefined)
    assert.equal(c.body_html, '纯画面演示')
    assert.equal(inferBodyState(c), 'summary_only', '无字幕但简介非空 → summary_only 进候选，不能全被预筛丢')
    assert.equal(d.body_html, null)
    assert.equal(d.subtitle_text, undefined)
    assert.equal(inferBodyState(d), 'missing')
    assert.equal(logs.filter(l => l.event.startsWith('yt_subtitle')).length, 0,
      '首选 zh-Hans 直接命中、无字幕也不是失败：都不该有字幕诊断行')
  })
})

test('vtt 兜底：该语言轨只落 vtt 文件时用极简解析器出全文', async () => {
  await withRoot(async subsRoot => {
    const only = { entries: [ENTRIES[0]] }
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: only }),
      subs: () => ({ files: [{ lang: 'zh-Hans', ext: 'vtt', text: VTT() }] })
    })
    const [a] = await fetchYtIt(spawnImpl, subsRoot)
    assert.equal(a.subtitle_text, '大家好\n讲 yt-dlp 的字幕 & 实体\n第三行')
  })
})

test('落盘优先级：zh 与 en 文件都在时用 zh（文件挑选顺序 = --sub-langs 的语言序），无 fallback 日志', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({
        files: [
          { lang: 'zh-Hans', ext: 'json3', text: JSON3(['中文轨文本']) },
          { lang: 'en-orig', ext: 'json3', text: JSON3(['english original']) }
        ]
      })
    })
    const [a] = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    assert.equal(a.subtitle_text, '中文轨文本')
    assert.equal(logs.filter(l => l.event === 'yt_subtitle_lang_fallback').length, 0)
  })
})

test('zh 限流（非零退出）但 en 已落盘 → 回退用 en 出字幕 + 恰一行 yt_subtitle_lang_fallback，不记 failed', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({
        files: [{ lang: 'en-orig', ext: 'json3', text: JSON3(['english fallback text']) }],
        exit: 1,
        stderr: "WARNING: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests"
      })
    })
    const [a] = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    assert.equal(a.subtitle_text, 'english fallback text')
    assert.equal(inferBodyState(a), 'subtitle')
    const fb = logs.filter(l => l.event === 'yt_subtitle_lang_fallback')
    assert.equal(fb.length, 1, '回退只记一行')
    assert.ok(fb[0].detail.includes('vidA1111111') && fb[0].detail.includes('en-orig'), fb[0].detail)
    assert.equal(logs.filter(l => l.event === 'yt_subtitle_failed').length, 0, '拿到了字幕就不是失败')
  })
})

test('字幕调用全军覆没（429 一文件未落）→ summary_only + 恰一行 yt_subtitle_failed；这是选择回退不是重试：不重打任何轨', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({
        files: [],
        exit: 1,
        stderr: "WARNING: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests"
      })
    })
    const [a] = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    assert.equal(a.subtitle_text, undefined)
    assert.equal(a.body_html, '这期讲适配器怎么写', '简介非空 → summary_only（下一轮照常走增量判断）')
    const failed = logs.filter(l => l.event === 'yt_subtitle_failed')
    assert.equal(failed.length, 1)
    assert.ok(failed[0].detail.includes('vidA1111111'))
    const subSpawns = spawnImpl.state.spawns.filter(s => s.args.includes('--write-auto-subs'))
    assert.equal(subSpawns.length, 1, '同一视频的字幕只打一次（最多消费已落盘文件，不重发请求）')
  })
})

test('无字幕视频（退出 0、零文件）→ summary_only、零字幕诊断行（没有轨不是失败）', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const items = await fetchYtIt(fakeSpawn(), subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    const [, , c, d] = items
    assert.equal(c.body_html, '纯画面演示')
    assert.equal(d.body_html, null)
    assert.equal(logs.filter(l => l.event.startsWith('yt_subtitle')).length, 0)
  })
})

test('tmp 清理：字幕解析进内存即删 <videoId> 目录；上一轮残留也先清再写', async () => {
  await withRoot(async subsRoot => {
    fs.mkdirSync(path.join(subsRoot, 'vidA1111111'), { recursive: true })
    fs.writeFileSync(path.join(subsRoot, 'vidA1111111', 'stale.junk'), 'x')
    await fetchYtIt(fakeSpawn(), subsRoot)
    for (const e of ENTRIES) {
      assert.equal(fs.existsSync(path.join(subsRoot, e.id)), false, `${e.id} 目录读完即删`)
    }
  })
})

test('字幕失败诊断脱敏：yt-dlp 尾行里的落盘绝对路径必须换成占位符（日志不含家目录路径）', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const leak = path.join(subsRoot, 'vidA1111111', 'vidA1111111.zh-Hans.json3')
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({ files: [], exit: 1, stderr: `ERROR: unable to write ${leak}: permission denied` })
    })
    await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    const failed = logs.filter(l => l.event === 'yt_subtitle_failed')
    assert.equal(failed.length, 1)
    assert.ok(!failed[0].detail.includes(subsRoot), `诊断行不得包含落盘路径（实际 ${failed[0].detail}）`)
    assert.ok(failed[0].detail.includes('<路径已隐去>'))
  })
})

test('since 不过滤（增量判定交给 putDraft 去重、backlog 交给 gate）：所有条目照常返回', async () => {
  await withRoot(async subsRoot => {
    const items = await fetchYtIt(fakeSpawn(), subsRoot, { since: 4102444800000 })
    assert.equal(items.length, 4)
  })
})

/* ───────────────────────── knownIds 跳过与每轮上限（M4b Task 3） ───────────
 * flat 列表每轮都是最新 30 条：没有 knownIds，首轮 30×~10s/3 并发 ≈100s 撞爆 90s
 * 预算 → 源永远 timeout → 游标永不推进 → 死循环。跳过 + 上限是预算分批不是丢：
 * 游标推进到窗口尾，下轮 knownIds 已含本轮 12 条，自然续传。 */

test('knownIds 跳过已入库：30 条列表、25 条已知 → 只对 5 条新视频发起 dump+字幕（恰 10 次 spawn），一行 yt_skipped_known', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const vids = Array.from({ length: 30 }, (_, i) => ({ id: `kn${String(i).padStart(10, '0')}`, title: `第${i}期` }))
    const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: vids } }) })
    const items = await fetchYtIt(spawnImpl, subsRoot, {
      knownIds: new Set(vids.slice(0, 25).map(v => v.id)),
      log: (event, detail) => logs.push({ event, detail })
    })
    assert.equal(items.length, 5, '只处理 5 条新视频')
    assert.deepEqual(items.map(x => x.external_id), vids.slice(25).map(v => v.id), '保序：剩列表尾部的 5 条')
    assert.equal(spawnImpl.state.spawns.filter(s => !s.args.includes('--flat-playlist')).length, 10,
      '5 条 × (dump + 字幕) 恰 10 次 spawn；已知条目一次都不该打（预算死循环的根）')
    const skipped = logs.filter(l => l.event === 'yt_skipped_known')
    assert.equal(skipped.length, 1, '跳过诊断只记一行')
    assert.match(skipped[0].detail, /25/)
    assert.equal(logs.filter(l => l.event === 'yt_deferred').length, 0, '剩 5 条没超上限，不该有 deferred')
  })
})

test('每轮新条目上限 12：30 条全新 → 只处理列表序前 12 条（=最新优先），一行 yt_deferred 把 18 条留给下轮', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const vids = Array.from({ length: 30 }, (_, i) => ({ id: `df${String(i).padStart(10, '0')}`, title: `第${i}期` }))
    const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: vids } }) })
    const items = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    assert.equal(items.length, 12)
    assert.deepEqual(items.map(x => x.external_id), vids.slice(0, 12).map(v => v.id))
    assert.equal(spawnImpl.state.spawns.filter(s => !s.args.includes('--flat-playlist')).length, 24, '12 条 × 2 次 spawn')
    const deferred = logs.filter(l => l.event === 'yt_deferred')
    assert.equal(deferred.length, 1)
    assert.match(deferred[0].detail, /12 条新视频/)
    assert.match(deferred[0].detail, /18 条留待下轮/)
  })
})

test('全部条目已入库 → 空数组（增量稳态：成功无新增，不是 empty 失败，游标照常推进）', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: [ENTRIES[0], ENTRIES[1]] } }) })
    const items = await fetchYtIt(spawnImpl, subsRoot, { knownIds: new Set([ENTRIES[0].id, ENTRIES[1].id]) })
    assert.deepEqual(items, [])
    assert.equal(spawnImpl.state.spawns.length, 1, '只有一次 flat 调用，dump/字幕一次都不该发起')
  })
})

/* ───────────────────────── 预算与取消 ───────────────────────── */

test('外层 abort：并发 3 下在飞的 3 个 dump 子进程全部被 kill、第 4 个不发起（孤儿调用消失）', async () => {
  await withRoot(async subsRoot => {
    const vids = Array.from({ length: 8 }, (_, i) => ({ id: `ord${String(i).padStart(8, '0')}`, title: `第${i}期` }))
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: vids } }),
      detail: () => ({ hang: true })
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20)
    try {
      await assert.rejects(() => fetchYtIt(spawnImpl, subsRoot, { signal: ac.signal }), e => e.name === 'AbortError')
    } finally {
      clearTimeout(timer)
    }
    const detailSpawns = spawnImpl.state.spawns.filter(s => !s.args.includes('--flat-playlist'))
    assert.equal(detailSpawns.length, 3, `abort 时只该有首波 3 条在飞（实际 ${detailSpawns.length}）`)
    assert.equal(spawnImpl.state.children.filter(c => c.isKilled()).length, 3, '每个在飞子进程都必须被 kill（不留孤儿）')
    assert.equal(spawnImpl.state.spawns.filter(s => s.args.includes('--write-auto-subs')).length, 0, 'dump 都没回来，字幕调用一次都不该发起')
  })
})

test('外层 abort 打在字幕调用上：dump 已回、字幕 spawn 在飞时 abort → 该子进程被 kill、AbortError 上抛、tmp 目录已清', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({ hang: true })
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 25)
    try {
      await assert.rejects(() => fetchYtIt(spawnImpl, subsRoot, { signal: ac.signal }), e => e.name === 'AbortError')
    } finally {
      clearTimeout(timer)
    }
    const subSpawn = spawnImpl.state.spawns.filter(s => s.args.includes('--write-auto-subs'))
    assert.equal(subSpawn.length, 1, 'dump 成功后发起过一次字幕调用')
    assert.equal(spawnImpl.state.children.filter(c => c.isKilled()).length, 1, '在飞的字幕子进程必须被 kill')
    assert.equal(fs.existsSync(path.join(subsRoot, 'vidA1111111')), false, 'abort 路径同样要清 tmp')
  })
})

test('子进程硬超时（防 yt-dlp 挂死）：注入 childTimeoutMs 40ms → TimeoutError 上抛、子进程被 kill', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn({ flat: () => ({ hang: true }) })
    await assert.rejects(
      () => fetchYtIt(spawnImpl, subsRoot, { childTimeoutMs: 40 }),
      e => e.name === 'TimeoutError' && /yt-dlp/.test(e.message)
    )
    assert.equal(spawnImpl.state.children[0].isKilled(), true)
  })
})

test('字幕调用同样吃硬超时：dump 正常、字幕 spawn 挂死 → TimeoutError 穿透整源上抛（游标不推进）+ 子进程被 kill', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn({
      flat: () => ({ json: { entries: [ENTRIES[0]] } }),
      subs: () => ({ hang: true })
    })
    await assert.rejects(
      () => fetchYtIt(spawnImpl, subsRoot, { childTimeoutMs: 40 }),
      e => e.name === 'TimeoutError' && /yt-dlp/.test(e.message)
    )
    const subChild = spawnImpl.state.children.filter((c, i) => spawnImpl.state.spawns[i].args.includes('--write-auto-subs'))
    assert.ok(subChild.some(c => c.isKilled()), '挂死的字幕子进程必须被 kill')
  })
})

test('单视频 dump 受限并发 3 保持顺序：在飞峰值恰 3，乱序完成输出仍按列表序', async () => {
  await withRoot(async subsRoot => {
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
          resolve({ json: { id: vids[i].id, title: `第${i}期`, duration: 300, upload_date: '20261020', description: `简介${i}`, uploader: '某频道' } })
        }, delays[i]))
      }
    })
    const items = await fetchYtIt(spawnImpl, subsRoot)
    assert.equal(items.length, 8)
    assert.deepEqual(items.map(x => x.external_id), vids.map(v => v.id), '输出顺序必须与输入顺序一致')
    assert.equal(maxInFlight, 3, `dump 并发上限应为 3（实测在飞峰值 ${maxInFlight}）`)
  })
})

/* ───────────────────────── 错误映射 ───────────────────────── */

test('yt-dlp 不存在（spawn ENOENT）→ error_class=unavailable，消息指路 yt_dlp_path，零字幕调用', async () => {
  await withRoot(async subsRoot => {
    await assert.rejects(
      () => fetchYtIt(fakeSpawn({ flat: () => ({ error: 'ENOENT' }) }), subsRoot),
      e => e.error_class === 'unavailable' && /yt_dlp_path/.test(e.message)
    )
  })
})

test('flat-playlist 非零退出 → parse 分类，尾行（stderr 优先）截断 120 字进诊断', async () => {
  await withRoot(async subsRoot => {
    const long = 'ERROR: ' + 'x'.repeat(300)
    await assert.rejects(
      () => fetchYtIt(fakeSpawn({ flat: () => ({ exit: 1, stderr: `WARNING: something\n${long}\n` }) }), subsRoot),
      e => {
        assert.equal(e.parse, true)
        assert.match(e.message, /退出码 1/)
        assert.ok(e.message.includes('x'.repeat(113)) && !e.message.includes('x'.repeat(114)), '尾行截断 120')
        return true
      }
    )
  })
})

test('flat-playlist 层失败：空 entries → empty；stdout 非 JSON / 空输出 → parse', async () => {
  await withRoot(async subsRoot => {
    await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ json: { entries: [] } }) }), subsRoot), e => e.empty === true)
    await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ stdout: 'not-json', exit: 0 }) }), subsRoot), e => e.parse === true)
    await assert.rejects(() => fetchYtIt(fakeSpawn({ flat: () => ({ stdout: '', exit: 0 }) }), subsRoot), e => e.parse === true)
  })
})

test('单视频 dump 失败（私享/删档视频）不拖垮整源：该条降级 missing（列表 title 兜底）且不再发起字幕调用，其余照常', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const spawnImpl = fakeSpawn({
      detail: ({ url }) => videoIdFrom(url) === 'vidA1111111'
        ? { exit: 1, stderr: 'ERROR: [youtube] vidA1111111: Private video' }
        : { json: DETAIL(videoIdFrom(url)) }
    })
    const items = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
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
    const subForA = spawnImpl.state.spawns.filter(
      s => s.args.includes('--write-auto-subs') && s.args.at(-1) === 'https://www.youtube.com/watch?v=vidA1111111'
    )
    assert.equal(subForA.length, 0, 'dump 都失败的条目不该再花一次字幕调用')
    assert.equal(spawnImpl.state.spawns.length, 8, '1 flat + 4 dump + 只有 3 条走到字幕')
  })
})

test('源 url 缺失/非 http(s) → error_class=bad_source，零 spawn', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn()
    await assert.rejects(
      () => ytAdapter.fetch({ id: 'b', type: 'yt', url: 'ftp://x/y' }, { spawnImpl, subsRoot }),
      e => e.error_class === 'bad_source'
    )
    await assert.rejects(
      () => ytAdapter.fetch({ id: 'b', type: 'yt', url: '' }, { spawnImpl, subsRoot }),
      e => e.error_class === 'bad_source'
    )
    assert.equal(spawnImpl.state.spawns.length, 0)
  })
})

test('列表项 id 形态异常（id 将成为落盘目录名，只许 [A-Za-z0-9_-]）→ 跳过该条 + 一行诊断', async () => {
  await withRoot(async subsRoot => {
    const logs = []
    const spawnImpl = fakeSpawn({ flat: () => ({ json: { entries: [{ id: '../evil', title: '坏 id' }, ENTRIES[0]] } }) })
    const items = await fetchYtIt(spawnImpl, subsRoot, { log: (event, detail) => logs.push({ event, detail }) })
    assert.equal(items.length, 1)
    assert.equal(items[0].external_id, 'vidA1111111')
    assert.ok(logs.some(l => l.event === 'yt_item_skipped'))
    assert.equal(fs.existsSync(path.join(subsRoot, '..', 'evil')), false, '不得在 subsRoot 外建目录')
  })
})

/* ───────────────────────── 偏好键 ───────────────────────── */

test('--proxy 传参：network.proxy 设置时每个 yt-dlp 调用（含字幕落盘）都带 --proxy <值>；yt_dlp_path 覆盖可执行名；未设置时绝不出现', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn()
    await fetchYtIt(spawnImpl, subsRoot, { pref: { yt_dlp_path: 'D:/tools/yt-dlp.exe', network: { proxy: 'http://127.0.0.1:7890' } } })
    assert.equal(spawnImpl.state.spawns[0].cmd, 'D:/tools/yt-dlp.exe')
    assert.equal(spawnImpl.state.spawns.length, 9)
    for (const s of spawnImpl.state.spawns) {
      const i = s.args.indexOf('--proxy')
      assert.ok(i >= 0, '缺 --proxy')
      assert.equal(s.args[i + 1], 'http://127.0.0.1:7890')
    }
    const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-yt-test-'))
    try {
      const plain = fakeSpawn()
      await fetchYtIt(plain, plainRoot)
      assert.ok(plain.state.spawns.every(s => !s.args.includes('--proxy')), '未设置代理时一个 --proxy 都不该有')
      assert.equal(plain.state.spawns[0].cmd, 'yt-dlp', '缺省 yt-dlp 走 PATH')
    } finally {
      fs.rmSync(plainRoot, { recursive: true, force: true })
    }
  })
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

test('单视频源（watch?v= / youtu.be）：跳过 flat、dump + 字幕共 2 次 spawn，产物照常三态', async () => {
  await withRoot(async subsRoot => {
    const watch = 'https://www.youtube.com/watch?v=vidA1111111'
    const spawnImpl = fakeSpawn({ detail: ({ url }) => ({ json: DETAIL(videoIdFrom(url)) }) })
    const done = await ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: watch }, {
      since: null, now: () => NOW, subsRoot, spawnImpl
    })
    assert.equal(spawnImpl.state.spawns.length, 2, '单视频源只该 dump + 字幕两次 spawn（无 flat）')
    assert.deepEqual(spawnImpl.state.spawns[0].args, ['--retries', '1', '--extractor-retries', '1', '--dump-single-json', watch])
    assert.ok(spawnImpl.state.spawns[1].args.includes('--write-auto-subs'))
    assert.equal(done.length, 1)
    assert.equal(done[0].external_id, 'vidA1111111')
    assert.equal(done[0].subtitle_text, '大家好\n第一期正文')
    assert.equal(done[0].duration_sec, 754)

    const bare = fakeSpawn({ detail: ({ url }) => ({ json: DETAIL(videoIdFrom(url)) }) })
    const items2 = await ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: 'https://youtu.be/vidC3333333?t=30' }, {
      since: null, now: () => NOW, subsRoot, spawnImpl: bare
    })
    assert.equal(bare.state.spawns.length, 2)
    assert.equal(items2[0].external_id, 'vidC3333333', 'youtu.be 短链也认')
    assert.equal(items2[0].body_html, '纯画面演示', '无字幕单视频 → summary_only')
  })
})

test('单视频源 dump 失败 → 整源失败上抛（没有列表可兜底，不产假 missing、游标不推进）', async () => {
  await withRoot(async subsRoot => {
    const spawnImpl = fakeSpawn({ detail: () => ({ exit: 1, stderr: 'ERROR: [youtube] vidA1111111: Video unavailable' }) })
    await assert.rejects(
      () => ytAdapter.fetch({ id: 'yt-one', type: 'yt', url: 'https://www.youtube.com/watch?v=vidA1111111' }, {
        since: null, now: () => NOW, subsRoot, spawnImpl
      }),
      e => e.parse === true && /Video unavailable/.test(e.message)
    )
    assert.equal(spawnImpl.state.spawns.filter(s => s.args.includes('--write-auto-subs')).length, 0, 'dump 死了就不该有字幕调用')
  })
})
