import test from 'node:test'
import assert from 'node:assert/strict'
import { CollectionsView, folderTabs, nameOf, currentFolderId } from '../src/client/views/collections.js'
import { Drawer } from '../src/client/views/drawer.js'
import { text, findAll } from './helpers/tree.mjs'

const FOLDERS = [
  { id: 1, name: '默认', is_default: 1, count: 2 },
  { id: 2, name: '公共管理', is_default: 0, count: 1 },
  { id: 3, name: '空夹', is_default: 0, count: 0 }
]
const item = (over = {}) => ({
  id: 1, kind: 'article', source_id: 'demo', title: '一条收过的文章', author: '某作者',
  status: 'new', body_state: 'full', verdict_tier: null, match_json: '{}',
  url: 'https://example.invalid/x', folders: [1], folder_names: ['默认'], added_at: 5000, ...over
})

test('左列夹：默认夹排第一，条数写在名字后面，当前夹标 aria-current', () => {
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 2 } })
  const tabs = findAll(tree, 'bl-foldertab')
  assert.deepEqual(tabs.map((t) => t.props['data-folder']), [1, 2, 3])
  assert.deepEqual(tabs.map((t) => t.props['aria-current']), ['false', 'page', 'false'])
  assert.match(text(tabs[0]), /默认（默认） 2 条/)
})

test('夹列表就算乱序进来，默认夹也排第一（不改数据，只给顺序）', () => {
  const shuffled = [{ id: 2, name: '公共管理', is_default: 0, count: 1 }, { id: 1, name: '默认', is_default: 1, count: 2 }]
  assert.deepEqual(folderTabs(shuffled).map((f) => f.id), [1, 2])
  assert.deepEqual(findAll(CollectionsView({ items: [], folders: shuffled, filters: {} }), 'bl-foldertab')
    .map((t) => t.props['data-folder']), [1, 2])
  assert.equal(shuffled[0].id, 2, 'folderTabs 不许把传进来的数组原地排了')
})

test('点夹名交出的是夹 id，不是名字', () => {
  const picked = []
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: {}, onPickFolder: (id) => picked.push(id) })
  findAll(tree, 'bl-foldertab')[2].props.onClick()
  assert.deepEqual(picked, [3])
})

test('一个夹都没读到时不画空标签栏，直接说读不到', () => {
  const tree = CollectionsView({ items: [], folders: [], filters: {} })
  const t = text(tree)
  assert.match(t, /读不到夹/)
  assert.equal(findAll(tree, 'bl-foldertab').length, 0)
})

test('右区显示这个夹里的条目，并带上"还在哪些夹里"', () => {
  const tree = CollectionsView({
    items: [item({ id: 1, folders: [1, 2], folder_names: ['默认', '公共管理'] })],
    folders: FOLDERS, filters: { folder: 1 }
  })
  const card = findAll(tree, 'bl-card')[0]
  assert.match(text(card), /一条收过的文章/)
  // 简报里这条写成 /还在：默认 / 公共管理/ ——斜杠在正则字面量里就终止了正则，是坏代码；按原意转义
  assert.match(text(card), /还在：默认 \/ 公共管理/)
})

test('卡上的时间是收进来的时间，不是发布时间', () => {
  const tree = CollectionsView({
    items: [item({ added_at: Date.parse('2026-01-02T03:04:05Z'), published_at: Date.parse('2025-01-01T00:00:00Z') })],
    folders: FOLDERS, filters: { folder: 1 }
  })
  assert.match(text(tree), /收进来/)
  assert.match(text(tree), /2026/)
  assert.doesNotMatch(text(tree), /2025-01-01/)
})

test('已归档的条目照样列出，并写明"收藏不会让它重新出现在今天"', () => {
  const t = text(CollectionsView({
    items: [item({ status: 'archived', archived_reason: 'stale:20 天前' })], folders: FOLDERS, filters: { folder: 1 }
  }))
  assert.match(t, /已归档：stale:20 天前/)
  assert.match(t, /不会让它重新出现在今天/)
})

test('归档条目没记原因时说明没记，不编一个原因', () => {
  const t = text(CollectionsView({ items: [item({ status: 'archived', archived_reason: null })], folders: FOLDERS, filters: { folder: 1 } }))
  assert.match(t, /已归档：原因没记/)
})

test('空夹、一条没收、读不到夹，三种空态说法不同', () => {
  const emptyFolder = text(CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 3 } }))
  assert.match(emptyFolder, /这个夹还是空的/)
  const nothingAtAll = text(CollectionsView({ items: [], folders: FOLDERS.map((f) => ({ ...f, count: 0 })), filters: {} }))
  assert.match(nothingAtAll, /一条都还没收过/)
  assert.doesNotMatch(nothingAtAll, /这个夹还是空的/)
  const unread = text(CollectionsView({ items: [], folders: [], filters: {} }))
  assert.doesNotMatch(unread, /一条都还没收过/, '把读不到说成"没收过"是谎')
  assert.doesNotMatch(unread, /这个夹还是空的/)
})

test('读不到夹时连卡片都不画：那些条目是"没筛夹"捞回来的，跟收藏无关', () => {
  const tree = CollectionsView({ items: [item(), item({ id: 2, title: '另一条' })], folders: [], filters: {} })
  assert.equal(findAll(tree, 'bl-card').length, 0)
  assert.match(text(tree), /读不到夹/)
})

test('工具条：新建夹输入框带 maxLength=40，改名走当前夹', () => {
  const created = []
  const renamed = []
  const tree = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 },
    onCreate: (n) => created.push(n), onRename: (id, n) => renamed.push([id, n]), newFolderName: '考研', currentName: '考研'
  })
  const inputs = findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'input')
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].props.maxLength, 40)
  assert.equal(inputs[1].props.value, '考研')
  inputs[1].props.onKeyDown({ key: 'Enter', target: { value: '新名' } })
  assert.deepEqual(renamed, [[2, '新名']])
  inputs[1].props.onKeyDown({ key: 'Tab', target: { value: '不该改' } })
  assert.equal(renamed.length, 1, '只有回车该提交改名，别的键在输入框里打字不该动库')
  findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'button')[0].props.onClick()
  assert.deepEqual(created, ['考研'], '「建夹」按钮该把输入框里的名字交出去')
})

test('改名框没草稿时回落到服务端读到的夹名，草稿交回装配层', () => {
  const typed = []
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 2 }, onCurrentNameChange: (v) => typed.push(v) })
  const inputs = findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'input')
  assert.equal(inputs[1].props.value, '公共管理')
  inputs[1].props.onChange({ target: { value: '改到一半' } })
  assert.deepEqual(typed, ['改到一半'])
  assert.match(inputs[0].props.placeholder, /1-40 字/)
})

test('删默认夹的按钮根本不出现；删自建夹要先二次确认，确认前不许动手', () => {
  const asked = []
  const deleted = []
  const def = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 1 }, onAskDelete: (id) => asked.push(id) })
  assert.doesNotMatch(text(def), /删除这个夹/)
  const mine = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 },
    onAskDelete: (id) => asked.push(id), onDelete: () => { deleted.push(1) }
  })
  const btn = findAll(mine, 'bl-toolbar')[0].children.find((n) => n.type === 'button' && text(n).includes('删除这个夹'))
  btn.props.onClick()
  assert.deepEqual(asked, [2])
  assert.equal(deleted.length, 0, '第一次点就把夹删了，二次确认形同虚设')
})

test('二次确认的文案说清"只删关系不删条目"，取消能退回正常工具条', () => {
  const cancelled = []
  const tree = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 }, pendingDelete: 2,
    onCancelDelete: () => cancelled.push('cancel'), onDelete: () => cancelled.push('delete')
  })
  const t = text(tree)
  assert.match(t, /只删收藏关系/)
  assert.match(t, /条目本身不动/)
  assert.match(t, /公共管理/)
  const btns = findAll(tree, 'bl-confirm')[0].children.filter((b) => b.type === 'button')
  assert.equal(btns.length, 2)
  btns.find((b) => text(b).includes('取消')).props.onClick()
  btns.find((b) => text(b).includes('确认删除')).props.onClick()
  assert.deepEqual(cancelled, ['cancel', 'delete'])
  assert.equal(findAll(tree, 'bl-toolbar').length, 0, '确认期间工具条该让位，不能两个输入框同时活着')
  const after = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 2 }, pendingDelete: null })
  assert.equal(findAll(after, 'bl-toolbar').length, 1)
  assert.equal(findAll(after, 'bl-confirm').length, 0)
})

test('确认框只跟着当前看的那个夹：pendingDelete 指的是别的夹时不许拦住这一夹', () => {
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 1 }, pendingDelete: 2 })
  assert.equal(findAll(tree, 'bl-confirm').length, 0)
  assert.equal(findAll(tree, 'bl-toolbar').length, 1)
})

test('建夹/改名的失败回显走同一行 note，不静默', () => {
  const t = text(CollectionsView({ items: [], folders: FOLDERS, filters: {}, note: '已经有这个夹了' }))
  assert.match(t, /已经有这个夹了/)
  assert.equal(findAll(CollectionsView({ items: [], folders: FOLDERS, filters: {} }), 'bl-feedback').length, 0, '没有话要说时不占一行')
})

test('点卡片交出条目 id（抽屉靠它打开）', () => {
  const opened = []
  const tree = CollectionsView({ items: [item({ id: 7 })], folders: FOLDERS, filters: { folder: 1 }, onOpen: (id) => opened.push(id) })
  findAll(tree, 'bl-card')[0].props.onClick()
  assert.deepEqual(opened, [7])
})

test('folderTabs 与 nameOf 两个纯函数', () => {
  assert.deepEqual(folderTabs([{ id: 5, is_default: 0 }, { id: 1, is_default: 1 }]).map((f) => f.id), [1, 5])
  assert.deepEqual(folderTabs(undefined), [])
  assert.equal(nameOf(FOLDERS, 2), '公共管理')
  assert.match(nameOf(FOLDERS, 99), /99（这个夹已经没了）/)
  assert.equal(nameOf(undefined, 1), '#1（这个夹已经没了）')
})

test('currentFolderId：筛选里没夹就落到默认夹，认不出的夹也回落，一个夹都没读到就是 null', () => {
  assert.equal(currentFolderId(FOLDERS, { folder: '2' }), 2)
  assert.equal(currentFolderId(FOLDERS, {}), 1)
  assert.equal(currentFolderId([{ id: 9, is_default: 0 }, { id: 4, is_default: 1 }], {}), 4)
  assert.equal(currentFolderId(FOLDERS, { folder: 99 }), 1, '筛选里那个夹刚被另一格删掉时不许继续拿它取数（恒空=谎）')
  assert.equal(currentFolderId([], {}), null)
  assert.equal(currentFolderId(FOLDERS, { folder: '不是数' }), 1)
})

test('筛选里是已经没了的夹：回落默认夹高亮，别把恒空说成"这个夹还是空的"', () => {
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 99 } })
  const tabs = findAll(tree, 'bl-foldertab')
  assert.deepEqual(tabs.map((t) => t.props['aria-current']), ['page', 'false', 'false'])
  assert.doesNotMatch(text(tree), /99/)
})

// 绑定约束（Task 7 评审留下的那条）：凡是"请求成功但内容读不回来"，抽屉与收藏页说同一句话，
// 而且必须明说"没读回来"——写成"没有夹"是把失败说成空的谎。
test('读回失败的话术全页面统一：抽屉与收藏页同一句，且明说没读回来', () => {
  const drawerText = text(Drawer({ item: item(), api: {}, folders: [] }))
  const pageText = text(CollectionsView({ items: [], folders: [], filters: {} }))
  assert.match(drawerText, /夹列表没读回来/)
  assert.match(pageText, /夹列表没读回来/)
  for (const t of [drawerText, pageText]) {
    assert.doesNotMatch(t, /你还没有夹|一个夹都没建/, '把读回失败写成"没有夹"是把失败说成空的谎')
  }
})
