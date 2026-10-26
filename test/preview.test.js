import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPreview, toHtml } from '../tools/preview.mjs'
import { previewState, previewItems, previewFolders } from './fixtures/preview-data.js'

// 写到系统临时目录，不往仓库里堆产物；测试自清（终审 #21）：登记进 tmpDirs，收尾钩子统一删。
const tmpDirs = []
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `baleen-preview-${tag}-`))
  tmpDirs.push(d)
  return d
}
const NAMES = ['preview-article.html', 'preview-collections.html', 'preview-digest.html', 'preview-drawer.html',
  'preview-library.html', 'preview-settings.html', 'preview-today.html', 'preview-trouble.html', 'preview-video.html']

test('六个视图 + 抽屉 + 出问题那一屏都出 HTML，每页明暗两块', () => {
  const files = renderPreview({ outDir: tmp('ok') })
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), NAMES)
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8')
    assert.match(html, /class="bl-root" data-preview="light"/)
    assert.match(html, /class="bl-root" data-preview="dark"/)
    assert.doesNotMatch(html, /<script/, '预览是静态产物，不该带脚本')
    assert.match(html, /替身/, 'token 值必须标明是替身，不然看着像宿主真实调色板')
    assert.doesNotMatch(html, /className=/, '吐的是 React 属性名，浏览器不认——整页样式会静默失效')
    // 设置页注册在宿主设置里，不套主面板外壳（导航是面板的事）；面板页该带导航
    if (path.basename(f) !== 'preview-settings.html') {
      assert.match(html, /<nav class="bl-nav"/, '每页都该带顶部导航，不然没法评"像不像网站"')
      assert.match(html, /今天 ·待判6|>今天</, '导航里的"今天"没出来')
    }
  }
})

test('出问题那一屏把异常带、失败源、空轨道一起演出来（这些平时要等真坏了才看到）', () => {
  const files = renderPreview({ outDir: tmp('trouble') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-trouble.html')), 'utf8')
  assert.match(html, /role="alert"/)
  assert.match(html, /这一轮没跑成：demo-weekly 超时/)
  assert.match(html, /偏好文件有 1 处问题/)
  assert.match(html, /demo-weekly 本轮失败（timeout），游标没推进/)
  assert.match(html, /bili 需要重新登录/)
  assert.match(html, /库里还没有视频/)
})

test('抽屉那页是"面板里开着抽屉"的样子，不是孤零零一个框', () => {
  const files = renderPreview({ outDir: tmp('drawer') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-drawer.html')), 'utf8')
  assert.match(html, /<section class="bl-rail"/, '抽屉页该有背后的面板')
  assert.match(html, /<aside class="bl-drawer"/)
  assert.match(html, /权重 \+0\.1/)
})

test('明暗两块是同一份标记，只差 token——预览不许为两种主题各画一遍', () => {
  const files = renderPreview({ outDir: tmp('same') })
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8')
    const blocks = [...html.matchAll(/<div class="bl-root" data-preview="(?:light|dark)">([\s\S]*?)<\/div>\s*(?=<p class="bl-cap">|<\/body>)/g)].map((m) => m[1])
    assert.equal(blocks.length, 2, path.basename(f) + ' 没凑齐明暗两块')
    assert.equal(blocks[0], blocks[1], path.basename(f) + ' 明暗两块内容不一样')
  }
})

test('预览用的是真视图函数：渲染结果里能找到视图自己的文案', () => {
  const files = renderPreview({ outDir: tmp('real') })
  const read = (n) => fs.readFileSync(files.find((f) => f.endsWith(n)), 'utf8')
  assert.match(read('preview-today.html'), /过筛 .*→ 候选 .*→ 待判/)
  assert.match(read('preview-today.html'), /收藏钉住 \d/, '「收藏钉住」chip 要在定稿前就看得见（明暗两块同源）')
  assert.match(read('preview-video.html'), /只能跳转/)
  assert.doesNotMatch(read('preview-video.html'), /可在抽屉内播/, '播放器 V5 才评估，预览不许演出许诺')
  assert.match(read('preview-video.html'), /23:45/, 'bili 夹具条目的时长徽章要渲染出来')
  assert.match(read('preview-video.html'), /class="bl-thumb"/, '缩略图占位要画出来')
  assert.match(read('preview-today.html'), /视频区 · 4/, '夹具加进 bili 视频后今天页的视频区不再是三条')
  assert.match(read('preview-article.html'), /左边没有条目|读原文/)
  assert.match(read('preview-library.html'), /状态|形态|档位|来源/)
  assert.match(read('preview-drawer.html'), /为什么给你/)
  assert.match(read('preview-today.html'), /对会话说一句「把今天的候选判一下」/, '待判提示要兑现 M3 的承诺')
  assert.doesNotMatch(read('preview-today.html'), /自动提示/)
})

test('空态在预览里也看得见（不许只渲染有数据的版本）', () => {
  const files = renderPreview({ outDir: tmp('empty'), empty: true })
  const read = (n) => fs.readFileSync(files.find((f) => f.endsWith(n)), 'utf8')
  assert.match(read('preview-digest.html'), /还没跑过一轮/)
  assert.match(read('preview-today.html'), /还没有一轮记录|还没有跑过一轮/)
  assert.match(read('preview-video.html'), /库里还没有视频/)
  assert.match(read('preview-article.html'), /左边没有条目/)
  assert.match(read('preview-library.html'), /库里还没有条目/)
  assert.match(read('preview-collections.html'), /读不到夹/, '夹列表读不回来时收藏页不许把失败装成空')
})

test('汇报页在预览里演真数据：夹具两条汇报按时间倒序，headline 与 tiers 计数都在', () => {
  const files = renderPreview({ outDir: tmp('digest') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-digest.html')), 'utf8')
  // 明暗两块各渲染一遍同一份标记（上一条测试守着），所以整页看到 2 条 × 2 块 = 4 张
  assert.equal([...html.matchAll(/<section class="bl-dsum"/g)].length, 4, '夹具的两条汇报在每块里都该渲染出来')
  assert.match(html, /判了 2 条：值得看 0 · 可以看 1 · 不值当 1/)
  assert.match(html, /判了 3 条：值得看 1 · 可以看 1 · 不值当 1/)
  assert.ok(html.indexOf('判了 2 条') < html.indexOf('判了 3 条'), '最新的一份排最前')
  assert.doesNotMatch(html, /今日精选|编辑推荐/, '演真形态不等于塞假内容')
})

test('夹具用的是假订阅名，不许把她的真实源写进仓库', () => {
  const files = renderPreview({ outDir: tmp('privacy') })
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8')
    assert.doesNotMatch(html, /messywritings|innei|ecosocialismandnature|b23\.tv|substack\.com/, path.basename(f) + ' 漏了真实源')
  }
})

test('toHtml 转义文本与属性，坏数据不会变成脚本', () => {
  assert.equal(toHtml({ type: 'p', props: { title: 'a"b' }, children: ['<x> & y'] }), '<p title="a&quot;b">&lt;x&gt; &amp; y</p>')
  assert.equal(toHtml(null), '')
  assert.equal(toHtml([1, 2]), '12')
  assert.equal(toHtml({ type: 'input', props: { type: 'search', onClick: () => {}, checked: false }, children: [] }), '<input type="search">')
})

test('收藏页预览：左列夹带条数，右区带「还在哪些夹里」与一个归档条目', () => {
  const files = renderPreview({ outDir: tmp('collections') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-collections.html')), 'utf8')
  assert.match(html, /默认（默认）/)
  assert.match(html, /还在：/)
  assert.match(html, /不会让它重新出现在今天/, '归档条目要写明收藏不会让它重新出现在今天')
  assert.match(html, /class="bl-foldertab"/)
  assert.match(html, /aria-current="page"/, '当前夹要有选中标记')
})

test('抽屉页里能看到「收藏到…」多选，且「这源多来点」已改名', () => {
  const files = renderPreview({ outDir: tmp('drawer2') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-drawer.html')), 'utf8')
  assert.match(html, /收藏到…/)
  assert.match(html, /放进：默认/)
  assert.match(html, /这源多来点/)
  // 导航六格里本来就有一格叫「收藏」，旧按钮的防回退断言只能盯抽屉本体那一块，
  // 否则会拿导航那格当证据假红。
  const drawerHtml = html.match(/<aside class="bl-drawer"[\s\S]*?<\/aside>/)?.[0] ?? ''
  assert.notEqual(drawerHtml, '', '抽屉页里该找得到抽屉本体')
  assert.doesNotMatch(drawerHtml, />收藏</, '旧名字的按钮还在抽屉里')
})

test('夹具自洽：每个夹的 count 必须等于实际挂着它的条数', () => {
  // 夹上的数字与点进去看到的条数不一致，收藏页就成了谎报覆盖面的那一格。
  // 这条不测渲染，测的是夹具自己别写错——写错夹具比写错视图更难查。
  for (const f of previewFolders) {
    const n = previewItems.filter((i) => (i.folders ?? []).includes(f.id)).length
    assert.equal(f.count, n, `${f.name} 的 count 是 ${f.count}，实际挂着 ${n} 条`)
  }
})

test('夹具自洽：bili 视频条目是适配器的真实形态（时长、封面占位、简介+字幕两段正文）', () => {
  // 适配器写库的形状：kind=video、duration_sec 有值、thumb=pic 补丁字段、
  // body_text 是"简介 + 字幕全文"两段、body_state=subtitle。夹具演的是这个，不是文章加个时长。
  const v = previewItems.find((i) => i.id === 9)
  assert.ok(v, '夹具里要有 id 9 的 bili 视频条目')
  assert.equal(v.kind, 'video')
  assert.equal(v.source_id, 'bili')
  assert.equal(v.body_state, 'subtitle')
  assert.ok(Number(v.duration_sec) > 0, '时长要有值，卡片徽章才有东西可写')
  assert.ok(v.thumb, '适配器会带 pic 封面字段，夹具占位不能空着')
  assert.match(v.body_text, /简介[\s\S]*字幕/, '正文要演出"简介 + 字幕"两段')
  assert.equal(v.verdict_tier, null, '新条目保持待判，不搅动已判条数与汇报的故事')
  assert.deepEqual(v.folders, [], '不挂夹，收藏页与钉住的条数故事不动')
})

test('夹具自洽：digest 的 headline 必须与自己那条 stats 同源，digest_count 等于条数', () => {
  // headline 模板与 lib/store.js saveVerdicts 是同一份字面量；headline 与 stats 对不上，
  // 汇报页就成了"摘要和计数各说各话"的那一格。created_at 与 stats.at 同值同理（now 只取一次）。
  assert.equal(previewState.digest_count, previewState.digests.length)
  for (const d of previewState.digests) {
    assert.equal(d.headline,
      `判了 ${d.stats.judged} 条：值得看 ${d.stats.tiers['值得看']} · 可以看 ${d.stats.tiers['可以看']} · 不值当 ${d.stats.tiers['不值当']}`)
    assert.equal(d.stats.at, d.created_at)
  }
  // latestDigests 按 id 倒序取：夹具数组也按同一顺序写，最新一条在最前
  for (let i = 1; i < previewState.digests.length; i++) {
    assert.ok(previewState.digests[i - 1].id > previewState.digests[i].id, 'digests 夹具要按 id 倒序')
    assert.ok(previewState.digests[i - 1].created_at >= previewState.digests[i].created_at)
  }
})

test('导航六格，收藏在文章之后汇报之前', () => {
  const files = renderPreview({ outDir: tmp('nav6') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-today.html')), 'utf8')
  // 「今天」那格带待判徽章（"今天 ·待判5"），钉顺序前先剥掉；type 属性排在 class 前面，锚点不能写 <button class=
  const labels = [...html.matchAll(/<button[^>]*class="bl-navitem"[^>]*>([^<]*)</g)].map((m) => m[1].replace(/ ·待判\d+$/, ''))
  assert.deepEqual([...new Set(labels)], ['今天', '视频', '文章', '收藏', '汇报', '库'])
})

test('设置页预览：四页签各一块纵排，源/偏好/凭据/库的关键元素、诚实占位与 danger 红字都在', () => {
  const files = renderPreview({ outDir: tmp('settings') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-settings.html')), 'utf8')
  // 源：列表行 + 新增表单
  assert.match(html, /demo-longform（rss · 长文源）/)
  assert.match(html, /最近抓取：正常/)
  assert.match(html, /aria-label="新增源"|新增源/)
  // 偏好：主题组简明格式与 tuning 两条偏移
  assert.match(html, /公共管理: 治理,订阅/)
  assert.match(html, /demo-longform: \+0\.1/)
  assert.match(html, /demo-weekly: -0\.2/)
  assert.match(html, /一键归零/)
  // 凭据与环境：cookie 状态、env 四行、两个诚实占位（文案逐字）
  assert.match(html, /B 站 cookie：已写入/)
  assert.match(html, /yt-dlp：没探测到/)
  assert.match(html, /小红书：未接入（M4b 待做）/)
  assert.match(html, /转写依赖：未实现（随 ASR 一起）/)
  // 库：数据目录占位、清空库红字 danger
  assert.match(html, /数据目录：&lt;HOME&gt;\/baleen/)
  assert.match(html, /class="bl-danger"/)
  assert.match(html, /清空库/)
  // 四页签条都在（每块自带一条 tab 条，当前格不同）
  assert.equal([...html.matchAll(/class="bl-foldertab"/g)].length >= 4 * 2, true, '四块 × 明暗 = 至少 8 枚页签钮')
})
