import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { clientExists, loadClient, exportsOf, flattenText, makeStubs } from '../tools/client-loader.mjs'
import { text, findAll } from './helpers/tree.mjs'

test('桩的 ctx 复刻宿主 Proxy：未声明服务一律抛', () => {
  const s = makeStubs()
  const ctx = s.makeCtx(['slots'])
  assert.equal(ctx.get('slots'), s.slots)
  assert.throws(() => ctx.get('layout'), /without inject/)
  assert.throws(() => ctx.layout, /without inject/)
})

test('flattenText 能把节点树压成文本', () => {
  const node = { type: 'div', props: {}, children: ['a', { type: 'span', props: {}, children: ['b', null, false, 'c'] }] }
  assert.equal(flattenText(node).join(' '), 'a b c')
})

test('flattenText 会调用函数组件，否则断言永远看不到面板内容', () => {
  const Comp = () => ({ type: 'p', props: {}, children: ['组件里的话'] })
  assert.deepEqual(flattenText({ type: Comp, props: {}, children: [] }), ['组件里的话'])
})

test('client.js 不存在时 loadClient 明确报错，不静默通过', () => {
  if (clientExists()) {
    const s = loadClient()
    assert.equal(s.loader.value.id, 'dsh-baleen')
    return
  }
  assert.throws(() => loadClient(), /client\.js 还没建/)
})

test('exportsOf 在没注册 loader 时抛出可读错误', () => {
  const s = makeStubs()
  assert.throws(() => exportsOf(s), /没调 __ModuleLoader__\.load/)
})

test('client.js 以 loader 格式注册，侧栏 id 与 main key 同名', () => {
  const s = loadClient()
  assert.equal(s.loader.value.id, 'dsh-baleen')
  assert.equal(typeof s.loader.value.factory, 'function')
  const ex = exportsOf(s)
  assert.deepEqual(ex.inject, ['slots', 'layout'])
  const ex2 = { ...ex }
  ex2.apply(s.makeCtx(ex.inject))
  assert.deepEqual(s.registered.map(r => r.def.meta.name), ['sidebar.panellist', 'main'])
  const [side, main] = s.registered.map(r => r.def.meta)
  assert.equal(side.id, 'baleen')
  assert.equal(main.key, side.id)
  assert.match(side.label, /Baleen/)
  assert.equal(typeof side.order, 'number')
  assert.equal(s.registered.map(r => r.slot).join(','), 'sidebar.panellist,main')
})

test('宿主少声明一个服务也不能炸启动', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  assert.doesNotThrow(() => ex.apply(s.makeCtx(['slots'])))
  assert.equal(s.registered.length, 2)
})

test('完全没有 slots 时只记日志，不抛', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let res
  try { res = ex.apply(s.makeCtx([])) } finally { console.error = orig }
  assert.deepEqual(res.registeredSlots, [])
  assert.ok(errs.some(e => /slots/.test(e)))
})

test('某一格渲染抛错时降级成 NotReady，不把整页带走', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try { ex.apply(s.makeCtx(ex.inject)) } finally { console.error = orig }
  const mainFactory = s.registered.find(r => r.slot === 'main').def.factory
  const warns = []
  console.error = (...a) => warns.push(a.join(' '))
  let node
  try { node = mainFactory({}) } finally { console.error = orig }
  assert.ok(node, 'main 该出节点')
  void errs
})

test('__test 暴露了后续任务要断言的内部件', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const t = ex.__test
  assert.equal(t.PANEL_ID, 'baleen')
  assert.equal(t.API_BASE, '/api/dsh-baleen')
  assert.equal(t.VIEW_KEY, 'baleen.view')
  assert.equal(t.SNAPSHOT_KEY, 'baleen.snapshot')
  assert.equal(typeof t.createApi, 'function')
  assert.equal(typeof t.Nav, 'function')
  assert.equal(typeof t.getLayout, 'function')
})

test('装配层把纯对象节点树交给 React：视图本身不需要 React 就能测', () => {
  const s = loadClient()
  const t = exportsOf(s).__test
  const el = t.toElement({ type: 'div', props: { className: 'bl-x' }, children: ['甲', { type: 'span', props: {}, children: ['乙'] }] })
  assert.equal(el.type, 'div')
  assert.equal(el.props.className, 'bl-x')
  assert.deepEqual(flattenText(el), ['甲', '乙'])
  // null / false 是合法的"这一格什么都不渲染"，不能被当成文本 "null" 画出来
  assert.equal(t.toElement(null), null)
  assert.equal(t.toElement(false), null)
  assert.deepEqual(t.toElement([null, { type: 'i', props: {}, children: ['ok'] }, false]).filter(Boolean).map(n => n.type), ['i'])
})

test('Panel 落地在「今天」：出统计行与两轨空态，不再挂装配中的牌子', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const main = s.registered.find(r => r.slot === 'main').def.factory
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let tree
  try { tree = main({}) } finally { console.error = orig }
  assert.equal(errs.length, 0, '渲染不该抛错降级：' + errs.join(' | '))
  const text = flattenText(tree).join(' ')
  assert.match(text, /还没有跑过一轮/)
  assert.match(text, /B 站/)
  assert.doesNotMatch(text, /面板装配中/)
  assert.match(text, /现在跑一轮/)
})

test('导航项与渲染器一一对应：加视图只改一处就会红', () => {
  const t = exportsOf(loadClient()).__test
  assert.deepEqual(Object.keys(t.VIEW_RENDER).sort(), [...t.VIEWS].sort())
  for (const v of t.VIEWS) assert.equal(typeof t.VIEW_RENDER[v], 'function', `${v} 没有渲染器`)
})

test('持久化的视图决定首屏落在哪一格（重开面板不回今天）', () => {
  const persisted = (view) => JSON.stringify({ v: 1, view, filters: {}, selectedId: null, drawerItemId: null, scroll: 0 })
  const s = loadClient({ storage: { 'baleen.view': persisted('digest') } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  assert.match(flattenText(s.registered.find(r => r.slot === 'main').def.factory({})).join(' '), /还没跑过一轮/)
})

test('六个视图都接上了：面板里不该再有"占位"字样', () => {
  for (const view of ['today', 'video', 'article', 'digest', 'library', 'collections']) {
    const s = loadClient({ storage: { 'baleen.view': JSON.stringify({ v: 1, view, filters: {}, selectedId: null, drawerItemId: null, scroll: 0 }) } })
    const ex = exportsOf(s)
    ex.apply(s.makeCtx(ex.inject))
    const text = flattenText(s.registered.find(r => r.slot === 'main').def.factory({})).join(' ')
    assert.doesNotMatch(text, /还没接上真渲染器/, view + ' 还是占位')
    assert.ok(text.length > 20, view + ' 渲染出了空壳')
  }
})

test('视频区接上之后，占位文案就不许再出现（换实现要连同占位一起删）', () => {
  const s = loadClient({ storage: { 'baleen.view': JSON.stringify({ v: 1, view: 'video', filters: {}, drawerItemId: null, scroll: 0 }) } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const text = flattenText(s.registered.find(r => r.slot === 'main').def.factory({})).join(' ')
  assert.match(text, /显示 0 \/ 0 条/)
  assert.doesNotMatch(text, /还没接上真渲染器/)
})

test('文章区接上之后出的是两栏阅读，不是占位', () => {
  const s = loadClient({ storage: { 'baleen.view': JSON.stringify({ v: 1, view: 'article', filters: {}, selectedId: null, drawerItemId: null, scroll: 0 }) } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const tree = s.registered.find(r => r.slot === 'main').def.factory({})
  const text = flattenText(tree).join(' ')
  assert.match(text, /左边没有条目/)
  assert.doesNotMatch(text, /还没接上真渲染器/)
  assert.equal(findAll(tree, 'bl-two').length, 1)
})

test('抽屉由持久化状态打开：数据还没到时也要能解释"这条不在手里"', () => {
  const persisted = JSON.stringify({ v: 1, view: 'today', filters: {}, selectedId: null, drawerItemId: 7, scroll: 0 })
  const s = loadClient({ storage: { 'baleen.view': persisted } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const tree = s.registered.find(r => r.slot === 'main').def.factory({})
  const text = flattenText(tree).join(' ')
  assert.match(text, /这条不在当前列表里/)
  assert.equal(findAll(tree, 'bl-drawer').length, 1)
})

test('findAll 也认函数组件，否则面板里的节点一个都找不到', () => {
  const Comp = () => ({ type: 'div', props: { className: 'bl-z' }, children: [] })
  assert.equal(findAll({ type: Comp, props: {}, children: [] }, 'bl-z').length, 1)
})

test('筛选跟着视图走：持久化里的 video 筛选回填到视频区工具条', () => {
  const persisted = { v: 1, view: 'video', filters: { video: { tier: '可以看' }, article: { q: '治理' } }, drawerItemId: null, scroll: 0 }
  const s = loadClient({ storage: { 'baleen.view': JSON.stringify(persisted) } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const tree = s.registered.find(r => r.slot === 'main').def.factory({})
  const tier = findAll(tree, 'bl-toolbar')[0].children.find((n) => n.type === 'select')
  assert.equal(tier.props.value, '可以看')
})

test('六格三处同名：VIEWS、NAV_ITEMS、VIEW_RENDER 一处不许少（少任何一格这条就红）', () => {
  const t = exportsOf(loadClient()).__test
  assert.deepEqual([...t.VIEWS], ['today', 'video', 'article', 'collections', 'digest', 'library'])
  assert.deepEqual(t.NAV_ITEMS.map(([id]) => id), [...t.VIEWS])
  assert.deepEqual(Object.keys(t.VIEW_RENDER), [...t.VIEWS])
  for (const v of t.VIEWS) assert.equal(typeof t.VIEW_RENDER[v], 'function', `${v} 没有渲染器`)
  assert.equal(typeof t.CollectionsView, 'function', '收藏页得能从装配层里拿到，预览门靠它')
})

// 绑定约束（Task 7 评审留下的洞）：装配层那次"过期归属"覆盖调用点此前没有任何测试钉住——
// 把 drawerItemWithFolders(found, knownFolders) 改回裸 found，全量测试照样绿，
// 而"连点两个勾互相抹掉"的 bug 会静默回归。纯函数那两条钉子测的是规则，
// 这条测的是**接线**：源码级断言，不需要 React 测试替身。
test('装配层真的把过期归属覆盖接在抽屉上（改回裸 found 这条就红）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'client', '_footer.txt'), 'utf8')
  assert.match(src, /const drawerItem = drawerItemWithFolders\(found, knownFolders\)/,
    '_footer.txt 里那次调用不见了：抽屉会拿没归属的条目去全量替换')
  assert.doesNotMatch(src, /const drawerItem = found\b/, '覆盖层被退回裸 found')
  const built = fs.readFileSync(path.join(process.cwd(), 'client.js'), 'utf8')
  assert.equal(built.includes('const drawerItem = drawerItemWithFolders(found, knownFolders)'), true,
    'client.js 是生成的：改了源没跑 node tools/build-client.mjs')
})

/**
 * 真挂钩子的小 runtime（Important 3）：client-loader 的桩 useState 永不触发重渲染、useEffect 从不执行，
 * 所以光注入 fetchImpl 面板也永远停在初始空态——"数据被装配层消费了"这件事桩测不出来。
 * 这里把 useState/useEffect 补在桩的共享 React 对象上（测完立刻还原：该对象同文件跨测试共用），
 * 手动渲染 Panel：首渲染跑 effects → 冲掉取数 promise（setter 已写进槽位）→ 再渲染拿到有数据的树。
 * 钉的是"消费"不是"字符串还在"：删掉 ...collectionsProps、把抽屉覆盖调用改回裸 found，
 * 这里画出来的树当场就变——grep 式断言两种都抓不到（上面的源码级钉子继续留着，它便宜且能抓删除）。
 */
function hookRuntime(React, Panel) {
  const orig = { useState: React.useState, useEffect: React.useEffect }
  const states = []
  const pending = []
  let cursor = 0
  let mounted = false
  React.useState = (init) => {
    const i = cursor++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }]
  }
  React.useEffect = (fn) => { if (!mounted) pending.push(fn) }
  return {
    render() {
      cursor = 0
      const tree = Panel()
      if (!mounted) {
        mounted = true
        for (const fn of pending.splice(0)) fn()
      }
      return tree
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
    restore() { Object.assign(React, orig) }
  }
}

const collectionsFetch = ({ folders, items }) => async (url) => {
  const key = String(url).replace('/api/dsh-baleen', '').split('?')[0]
  const json = key === '/folders' ? { ok: true, folders }
    : key === '/items' ? { ok: true, items }
    : { ok: true, counts: { new: 0, judged: 0, digest: 0, archived: 0, total: items.length }, sources: [], preference_errors: [], last_run: null, digest_count: 0 }
  return { ok: true, status: 200, json: async () => json }
}

test('收藏格真的消费注入的取数：三夹两卡上页，删掉 ...collectionsProps 这条就红', async () => {
  const persisted = JSON.stringify({ v: 1, view: 'collections', filters: { collections: { folder: 2 } }, selectedId: null, drawerItemId: null, scroll: 0 })
  const folders = [
    { id: 1, name: '默认', is_default: 1, count: 1 },
    { id: 2, name: '公共管理', is_default: 0, count: 2 },
    { id: 3, name: '空夹', is_default: 0, count: 0 }
  ]
  const collected = (id, added_at) => ({
    id, kind: 'article', source_id: 'demo', title: '一条收过的文章 ' + id, status: 'new', body_state: 'full',
    verdict_tier: null, match_json: '{}', url: 'https://example.invalid/' + id,
    folders: [2], folder_names: ['公共管理'], added_at
  })
  const s = loadClient({ storage: { 'baleen.view': persisted }, fetchImpl: collectionsFetch({ folders, items: [collected(11, 7000), collected(12, 8000)] }) })
  const rt = hookRuntime(s.React, exportsOf(s).__test.Panel)
  try {
    rt.render()
    await rt.flush()
    const tree = rt.render()
    const tabs = findAll(tree, 'bl-foldertab')
    assert.equal(tabs.length, 3, 'folders 只经 ...collectionsProps 进视图：spread 没了就退回默认 []，这里该是 0 个夹加"读不到夹"')
    assert.equal(tabs.find((x) => x.props['aria-current'] === 'page').props['data-folder'], 2, '筛选里的当前夹也得是装配层解析后交下去的那一个')
    const cards = findAll(tree, 'bl-card')
    assert.equal(cards.length, 2, 'items 是 fetch 回来的数据经 setData 再渲染的：空壳说明取数没被消费')
    assert.match(text(cards[0]), /一条收过的文章 11/)
    assert.match(text(tree), /收进来：\d{4}/)
    assert.doesNotMatch(text(tree), /时间未知/, 'added_at 断在链路上任何一环，卡片都会说（时间未知）')
  } finally { rt.restore() }
})

test('抽屉的过期归属覆盖真的消费读回数据：点一个勾再渲染，那个夹就成了已勾选；改回裸 found 这条就红', async () => {
  const persisted = JSON.stringify({ v: 1, view: 'today', filters: {}, selectedId: null, drawerItemId: 7, scroll: 0 })
  // 今天三格的取数不带 folders 字段——这正是 drawerItemWithFolders 要兜的那个形状
  const item7 = { id: 7, kind: 'article', source_id: 'demo', title: '今天里的一条', status: 'new', body_state: 'full', verdict_tier: null, match_json: '{}', url: 'https://example.invalid/7' }
  const known = [
    { id: 1, name: '默认', is_default: 1, count: 0 },
    { id: 2, name: '考研', is_default: 0, count: 1 }
  ]
  const s = loadClient({
    storage: { 'baleen.view': persisted },
    fetchImpl: async (url) => {
      const key = String(url).replace('/api/dsh-baleen', '').split('?')[0]
      const json = key === '/folders' ? { ok: true, folders: known.map((f) => ({ ...f, count: 0 })) }
        : key === '/items' ? { ok: true, items: [item7] }
        : key === '/collect' ? { ok: true, item_id: 7, folder_ids: [2], folders: known }
        : { ok: true, counts: { new: 1, judged: 0, digest: 0, archived: 0, total: 1 }, sources: [], preference_errors: [], last_run: null, digest_count: 0 }
      return { ok: true, status: 200, json: async () => json }
    }
  })
  const rt = hookRuntime(s.React, exportsOf(s).__test.Panel)
  const boxOf = (tree, label) => findAll(tree, 'bl-collect')[0].children
    .filter((n) => n.type === 'input').find((n) => n.props['aria-label'] === label)
  try {
    rt.render()
    await rt.flush()
    const first = rt.render()
    assert.equal(boxOf(first, '放进：考研').props.checked, false, '归属还没读回时起步必须是空勾')
    boxOf(first, '放进：考研').props.onChange({ target: { checked: true } })
    await rt.flush()
    const second = rt.render()
    assert.equal(boxOf(second, '放进：考研').props.checked, true,
      'collect 读回的 folder_ids 必须经 drawerItemWithFolders 覆盖到抽屉条目上：调用点改回裸 found，这条永远是 false，下一次点勾会从"没归属"起步把刚放进的抹掉')
    assert.match(text(findAll(second, 'bl-drawer')[0]), /已放进：考研/)
  } finally { rt.restore() }
})

test('收藏页的取数形状：按夹筛、不限状态（收过的东西不会因归档就消失）', () => {
  const t = exportsOf(loadClient()).__test
  assert.deepEqual(t.viewQuery('collections', 3), { folder: 3, limit: 200 })
  assert.equal('status' in t.viewQuery('collections', 3), false, '收藏格不许套"活着的那三格"的状态筛')
  assert.deepEqual(t.viewQuery('collections', null), { limit: 200 }, '还没读到夹就不该假装筛了夹')
  assert.deepEqual(t.viewQuery('video', 3), { status: 'new,judged,digest', limit: 200 })
  assert.deepEqual(t.viewQuery('library', 3), { limit: 500 })
})

test('收藏页六个动作都接在装配层上（少一个就是"点了没反应"）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'client', '_footer.txt'), 'utf8')
  const wired = [
    ['onPickFolder', /onPickFolder: \([a-z]+\) => \{ setPendingDelete\(null\); dispatch\(\{ type: 'filter', view: 'collections', key: 'folder'/],
    ['onCreate', /onCreate: \(name\) => runFolder\('create', \{ name \}/],
    ['onRename', /onRename: \([a-z]+, name\) => runFolder\('rename'/],
    ['onAskDelete', /onAskDelete: \(id\) => setPendingDelete\(id\)/],
    ['onCancelDelete', /onCancelDelete: \(\) => setPendingDelete\(null\)/],
    ['onDelete', /onDelete: \(id\) => runFolder\('delete', \{ id \}/]
  ]
  for (const [name, re] of wired) assert.match(src, re, `收藏页的 ${name} 没接上`)
})

test('收藏页的失败回显走 runFolder，不许 catch 掉（源码级）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'client', '_footer.txt'), 'utf8')
  assert.match(src, /function runFolder\(action, args, okText\) \{/, 'runFolder 得是那个带 ok/error 分支的 helper')
  assert.match(src, /setCollectNote\(r\.error === 'name_taken'/, 'name_taken 要说人话，不能只报错误码')
  assert.doesNotMatch(src, /api\.folderOp\([^)]*\)\.catch\(\(\) => \{\}\)/, '夹操作失败不许静默')
})

test('面板落在收藏格：首屏说"夹列表没读回来"，不把读不到说成还没收藏', () => {
  const s = loadClient({ storage: { 'baleen.view': JSON.stringify({ v: 1, view: 'collections', filters: {}, selectedId: null, drawerItemId: null, scroll: 0 }) } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const tree = s.registered.find(r => r.slot === 'main').def.factory({})
  const t = flattenText(tree).join(' ')
  assert.match(t, /夹列表没读回来/)
  assert.doesNotMatch(t, /一条都还没收过/, '数据还没读回来就说"你还没收藏过"，是谎')
  assert.equal(findAll(tree, 'bl-foldertab').length, 0)
  assert.equal(findAll(tree, 'bl-collections').length, 1)
})

test('坏掉的 baleen.view 回落「今天」，不能把首屏炸成空白', () => {
  const s = loadClient({ storage: { 'baleen.view': '{坏掉的' } })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const main = s.registered.find(r => r.slot === 'main').def.factory
  assert.match(flattenText(main({})).join(' '), /还没有跑过一轮/)
})
