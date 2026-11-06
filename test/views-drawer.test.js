import test from 'node:test'
import assert from 'node:assert/strict'
import { Drawer, boundaryNote, playerEmbed, feedbackHint, collectSetOf, drawerItemWithFolders } from '../src/client/views/drawer.js'
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

test('能力边界按嵌入形态给说法：可嵌入=内嵌播放，解析不出=跳浏览器，其余说明内容边界', () => {
  // b23.tv 短链解析不出 BV 号 → 跳浏览器
  const bili = boundaryNote(item({ kind: 'video', source_id: 'bili' }))
  assert.match(bili, /跳到浏览器里看/)
  assert.doesNotMatch(bili, /M4 接入/, '旧文案（播放器没定下来）已过时：V5 实证后内嵌已落地')
  assert.match(boundaryNote(item({ kind: 'video', source_id: 'xhs' })), /只能跳/)
  assert.match(boundaryNote(item({ kind: 'article', source_id: 'substack', body_state: 'summary_only' })), /只给摘要/)
  assert.match(boundaryNote(item({ kind: 'video', body_state: 'burned_in' })), /硬字幕/)
  assert.match(boundaryNote(item({ kind: 'video', body_state: 'missing' })), /读不到/)
  // 能解析出 BV 号 → 内嵌播放的说法（V5 实证后面板页 iframe 不被拦）
  const embeddable = boundaryNote(item({ kind: 'video', source_id: 'bili', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }))
  assert.match(embeddable, /内嵌播放器在上方/)
})

test('playerEmbed：B 站 BV 号与 YouTube 两种嵌入形态，其余平台 null', () => {
  assert.deepEqual(
    playerEmbed('https://www.bilibili.com/video/BV1GJ411x7h7?p=3'),
    { kind: 'bili', src: 'https://www.bilibili.com/video/BV1GJ411x7h7' }
  )
  assert.deepEqual(
    playerEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'),
    { kind: 'youtube', src: 'https://www.youtube.com/embed/dQw4w9WgXcQ' }
  )
  assert.deepEqual(
    playerEmbed('https://youtu.be/dQw4w9WgXcQ'),
    { kind: 'youtube', src: 'https://www.youtube.com/embed/dQw4w9WgXcQ' }
  )
  assert.equal(playerEmbed('https://innei.in/notes/221'), null)
  assert.equal(playerEmbed('https://b23.tv/x'), null, '短链解析不出 BV 号，不硬猜')
  assert.equal(playerEmbed(''), null)
})

test('视频抽屉带内嵌播放 iframe（可嵌入时），文章抽屉不带', () => {
  const video = Drawer({ item: item({ kind: 'video', source_id: 'bili', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {} })
  const player = findAll(video, 'bl-player')
  assert.equal(player.length, 1)
  assert.match(player[0].props.src, /bilibili\.com\/video\/BV1GJ411x7h7/)
  const article = Drawer({ item: item({ kind: 'article' }), api: {} })
  assert.equal(findAll(article, 'bl-player').length, 0, '文章没有播放器')
  // 短链解析不出 → 不摆空壳 iframe
  const short = Drawer({ item: item({ kind: 'video', source_id: 'bili' }), api: {} })
  assert.equal(findAll(short, 'bl-player').length, 0)
})

// 抽屉里的完整页 iframe 会带出平台的推荐流：裁掉窗口高度是产品意图（不让人顺着刷下去），
// 复用侧栏播放器那一套 .bl-stage / .bl-stage-crop 样式，不另写一份 CSS。
test('内嵌播放的 iframe 外面包着 bl-stage.bl-stage-crop，样式与侧栏播放器同源', () => {
  const tree = Drawer({ item: item({ kind: 'video', source_id: 'bili', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {} })
  const stage = findAll(tree, 'bl-stage')[0]
  assert.ok(stage, 'iframe 必须有个容器，裸 iframe 没法裁推荐区')
  assert.equal(stage.type, 'div')
  assert.equal(findAll(tree, 'bl-stage-crop').length, 1, '不带 crop 的话下面半截推荐流就露出来了')
  assert.equal(findAll(tree, 'bl-player').length, 1, '包一层不该多出一个播放器')
  assert.equal(stage.children.length, 1)
  assert.equal(stage.children[0].type, 'iframe')
  assert.equal(stage.children[0].props.className, 'bl-player', 'iframe 只留自己的类，容器类挂在外层')
})

test('视频条目的抽屉带时长（fmtDuration 同一写法，缺时长就整段不显示）', () => {
  assert.match(text(Drawer({ item: item(), api: {} })), /时长 18:22/)
  assert.doesNotMatch(text(Drawer({ item: item({ duration_sec: null }), api: {} })), /时长/)
})

test('字幕态的抽屉说明"字幕全文已存，正文区就是字幕"，不与读不到混谈', () => {
  const t = text(Drawer({ item: item({ body_state: 'subtitle' }), api: {} }))
  assert.match(t, /字幕全文已存/)
  assert.doesNotMatch(t, /读不到内容/)
})

test('两个按钮的说明写清只调来源权重、不动主题词', () => {
  const t = text(Drawer({ item: item(), api: {} }))
  assert.match(t, /不感兴趣/)
  assert.match(t, /这源多来点/)
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
  await btn(tree, '这源多来点').props.onClick()
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

// 档 A：抽屉里那句"跳到浏览器里看"曾经是空头支票——URL 渲染成的是 <p>，点不动。
// 现在它必须是真链接；且地址不是 http/https 就整段不画，不摆一颗点不动的假按钮。
test('原文地址是真链接，不是一段点不动的文本', () => {
  const tree = Drawer({ item: item({ url: 'https://www.bilibili.com/video/BV1xx' }), api: {} })
  const a = findAll(tree, 'bl-url').find((n) => n.type === 'a')
  assert.ok(a, '链接得是 <a>，不是 <p>')
  assert.equal(a.props.href, 'https://www.bilibili.com/video/BV1xx')
  assert.equal(a.props.target, '_blank')
  assert.match(String(a.props.rel), /noopener/)
  assert.match(String(a.props.rel), /noreferrer/)
})

test('地址不是 http/https 时整段不画：没有链接也没有打开按钮', () => {
  for (const bad of [null, '', '   ', 'file:///c/x.mp4', 'javascript:alert(1)']) {
    const tree = Drawer({ item: item({ url: bad }), api: {} })
    assert.equal(findAll(tree, 'bl-url').length, 0, '坏地址不许出链接：' + String(bad))
    assert.equal(findAll(tree, 'bl-openbtns').length, 0, '坏地址不许出打开按钮：' + String(bad))
  }
})

test('打开路只有系统浏览器一颗按钮，且明说侧栏为什么不在（2026-10-31 真机验收后撤）', () => {
  const tree = Drawer({ item: item(), api: {}, onOpenUrl: () => {} })
  const btns = findAll(tree, 'bl-openbtns')[0].children.map((b) => text(b))
  assert.deepEqual(btns, ['浏览器打开'])
  assert.match(text(tree), /侧栏[^。]*排队/, '撤掉侧栏按钮要说清原因，不是悄悄少了一颗（M7：面板在前台时只会排队）')
  assert.doesNotMatch(text(tree), /侧栏浏览器这次没开起来/, '旧文案（页签不在）已不成立：页签在也开不出来')
})

test('浏览器打开把真地址与条目 id 一起交给回调（id 是宿主查库取 URL 的钥匙）', () => {
  const got = []
  const tree = Drawer({
    item: item({ id: 42, url: 'https://www.bilibili.com/video/BV1xx' }),
    api: {},
    onOpenUrl: (u, id) => got.push([u, id])
  })
  const btn = findAll(tree, 'bl-openbtns')[0].children[0]
  btn.props.onClick()
  assert.deepEqual(got, [['https://www.bilibili.com/video/BV1xx', 42]])
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

const FOLDERS = [
  { id: 1, name: '默认', is_default: 1, count: 0 },
  { id: 2, name: '公共管理', is_default: 0, count: 3 },
  { id: 3, name: '要精读', is_default: 0, count: 1 }
]

test('「收藏到…」把这条当前所属的夹回填成勾选', () => {
  const tree = Drawer({ item: item({ folders: [2] }), api: {}, folders: FOLDERS })
  const boxes = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')
  assert.equal(boxes.length, 3)
  assert.deepEqual(boxes.map((b) => Boolean(b.props.checked)), [false, true, false])
  assert.deepEqual(boxes.map((b) => b.props['aria-label']), ['放进：默认', '放进：公共管理', '放进：要精读'])
})

test('点一个夹名就是立刻放进，提交的是"当前集合 + 这一个"', async () => {
  const sent = []
  const api = { collect: async (id, folderIds) => { sent.push([id, folderIds]); return { ok: true, data: { folder_ids: folderIds } } } }
  const tree = Drawer({ item: item({ folders: [2] }), api, folders: FOLDERS })
  const box = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[0]
  await box.props.onChange({ target: { checked: true } })
  assert.deepEqual(sent, [[1, [2, 1]]], '放进的顺序该跟这条当前所属的记法一致：原有在前、新勾追加')
})

test('再点一次是移出，集合里减掉那一个', async () => {
  const sent = []
  const api = { collect: async (id, folderIds) => { sent.push(folderIds); return { ok: true } } }
  const tree = Drawer({ item: item({ folders: [2, 3] }), api, folders: FOLDERS })
  const box = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[1]
  await box.props.onChange({ target: { checked: false } })
  assert.deepEqual(sent, [[3]])
})

test('collectSetOf 不靠夹列表的顺序反推，条目里多出来的未知夹 id 要保留', () => {
  assert.deepEqual(collectSetOf({ folders: [9] }, FOLDERS, 1, true), [9, 1])
  assert.deepEqual(collectSetOf({ folders: [1, 9] }, FOLDERS, 1, false), [9])
  assert.deepEqual(collectSetOf(null, FOLDERS, 2, true), [2])
})

// 绑定约束（"连点两次互相抹掉"的钉子）：/collect 是全量替换，抽屉那条来自不带
// folders 字段的查询时，第一次成功读回的归属必须覆盖回抽屉这一条，第二次点击才是在
// 真集合上做增删。这里用纯函数钉住整条链路：点击1 → 提交集合 → 装配层写回
// knownFolders → drawerItemWithFolders 覆盖 → 点击2 提交合并集合。
// （选纯函数级而非装配级：Panel 在桩 React 下要驱动两次异步渲染才能复现连点，
//   测的是脚手架不是不变量；overlay 的每个分支下面单独钉。）
test('连点两个勾不互相抹掉：第一次读回覆盖后，第二次提交的是合并集合', () => {
  const base = item() // 今天的三格查询不带 folders 字段：那是"没读到"，不是"在 0 个夹里"
  const first = collectSetOf(base, FOLDERS, 1, true)
  assert.deepEqual(first, [1])
  const overlaid = drawerItemWithFolders(base, { itemId: base.id, folder_ids: first })
  assert.deepEqual(overlaid.folders, [1], '读回的归属要覆盖到抽屉这一条上')
  assert.deepEqual(collectSetOf(overlaid, FOLDERS, 2, true), [1, 2], '第二点该是 1+2，不是只有 2')
  // 反例钉住"这层为什么必须在"：没有覆盖，第二次全量替换就会把第一次的放进整个抹掉
  assert.deepEqual(collectSetOf(base, FOLDERS, 2, true), [2])
})

test('drawerItemWithFolders 只在"归属没读到且是同一条"时覆盖，其余原样', () => {
  const base = item()
  assert.equal(drawerItemWithFolders(null, { itemId: 1, folder_ids: [1] }), null, '没打开抽屉不该造出条目')
  assert.equal(drawerItemWithFolders(base, null), base, '还没成功收藏过就原样')
  // 条目自带 folders（比如收藏页的查询带字段）时以列表真相为准，不被旧读回盖掉
  assert.deepEqual(drawerItemWithFolders(item({ folders: [2] }), { itemId: 1, folder_ids: [1] }).folders, [2])
  // 别的条目的读回不许贴到这一条上（换条目开抽屉时必须从头算）
  assert.equal(drawerItemWithFolders(base, { itemId: 99, folder_ids: [1] }), base)
})

test('没有夹列表时（路由缺席）说读不到，不给一组空勾', () => {
  const t = text(Drawer({ item: item(), api: {}, folders: [] }))
  assert.match(t, /读不到夹/)
  assert.doesNotMatch(t, /放进：/)
})

test('new_folder 那行：空白名不发，发了就带上', async () => {
  const sent = []
  const api = { collect: async (id, folderIds, nf) => { sent.push([id, folderIds, nf]); return { ok: true } } }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS })
  const row = findAll(tree, 'bl-newfolder')[0]
  await row.children.find((n) => n.type === 'button').props.onClick({ })
  assert.deepEqual(sent, [], '没填名字不该发请求')
})

test('collect 失败的回显分两种：没记上 / 夹已经不在了', async () => {
  const done = []
  const api = { collect: async () => ({ ok: false, error: 'folder_gone', missing: [3] }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[2].props.onChange({ target: { checked: true } })
  assert.match(done[0], /没记上/)
  assert.match(done[0], /已经不在了/)
  // 绑定约束：folder_gone 要说清是哪几个夹没了，不是只报个数
  assert.match(done[0], /夹 3 已经不在了/)
  assert.doesNotMatch(done[0], /有 \d+ 个夹/)
})

test('新建重名夹：抽屉把 name_taken 说成人话，不直出英文短码（终审 D1）', async () => {
  const done = []
  const api = { collect: async () => ({ ok: false, error: 'name_taken' }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, newFolderName: '默认', onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-newfolder')[0].children.find((n) => n.type === 'button').props.onClick()
  assert.match(done[0], /已经有这个夹了/)
  assert.doesNotMatch(done[0], /name_taken/, '英文短码直出给用户了')
})

test('folder_gone 缺多个夹时把 id 挨个列出来', async () => {
  const done = []
  const api = { collect: async () => ({ ok: false, error: 'folder_gone', missing: [2, 3] }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[1].props.onChange({ target: { checked: true } })
  assert.match(done[0], /没记上/)
  assert.match(done[0], /已经不在了/)
  assert.match(done[0], /夹 2、3 已经不在了/)
})

// 统一"读回失败"话术（Task 8 裁定）：请求成了但内容没读回来，必须明说没读回来。
test('collect 应答里什么都没读回来时不许光说"已放进"：得带上归属没读回来', async () => {
  const done = []
  const api = { collect: async () => ({ ok: true, data: null }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[0].props.onChange({ target: { checked: true } })
  assert.match(done[0], /已放进/)
  assert.match(done[0], /归属没读回来/, '把"没读回来"说成"已放进"是谎')
})

test('folder_gone 但应答没带 missing 时，说明是哪几个没读回来（与收藏页同一句骨架）', async () => {
  const done = []
  const api = { collect: async () => ({ ok: false, error: 'folder_gone' }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[1].props.onChange({ target: { checked: true } })
  assert.match(done[0], /没记上/)
  assert.match(done[0], /是哪几个没读回来/)
})

test('收藏动作不发出去时不给"忙"的样子，防连点叠请求', () => {
  const tree = Drawer({ item: item({ folders: [] }), api: {}, folders: FOLDERS, collecting: true })
  const boxes = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')
  assert.equal(boxes.every((b) => b.props.disabled === true), true)
})

test('改名后的按钮仍然只写 tuning：提示文案里出现「这源多来点」且带 +0.1', () => {
  assert.match(feedbackHint('save'), /这源多来点/)
  assert.match(feedbackHint('save'), /\+0\.1/)
  assert.match(feedbackHint('save'), /不改你的主题词/)
  assert.doesNotMatch(feedbackHint('save'), /^收藏/)
})

test('原文段那句侧栏说明要按嵌入形态分别说真话（M7：面板里点侧栏只会排队）', () => {
  const can = text(Drawer({ item: item({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {} }))
  assert.match(can, /会话里点|排队/)
  assert.match(can, /上面的播放器|内嵌播放/, '能内嵌的要指回播放器，别把人推向系统浏览器')
  const exits = findAll(Drawer({ item: item({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {} }), 'bl-openbtns')[0].children.map((b) => text(b))
  assert.deepEqual(exits, ['浏览器打开'], '原文段只留这一个出口：侧栏按钮在面板里点了没反应（M7 实测排队），不许再摆')
  const cant = text(Drawer({ item: item({ url: 'https://b23.tv/x' }), api: {} }))
  assert.match(cant, /排队|侧栏播不了/)
  assert.doesNotMatch(cant, /上面的播放器/, '这条压根播不了，不许指一个不存在的播放器')
})
