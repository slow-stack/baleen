import test from 'node:test'
import assert from 'node:assert/strict'
import { Nav, TopBar, NotReady, NAV_ITEMS } from '../src/client/views/shell.js'
import { VIEWS } from '../src/client/view-state.js'
import { text, findAll } from './helpers/tree.mjs'

test('导航五格与 VIEWS 一字不差，顺序就是点击顺序', () => {
  assert.deepEqual(NAV_ITEMS.map(([id]) => id), [...VIEWS])
  assert.deepEqual(NAV_ITEMS.map(([, l]) => l), ['今天', '视频', '文章', '汇报', '库'])
})

test('当前格带 aria-current，别的格没有；品牌名在导航里', () => {
  const tree = Nav({ view: 'article', pending: 0, onPick: () => {} })
  const items = findAll(tree, 'bl-navitem')
  assert.equal(items.length, 5)
  assert.deepEqual(items.map((n) => n.props['aria-current']), ['false', 'false', 'page', 'false', 'false'])
  assert.match(text(tree), /Baleen/)
})

test('待判数只挂在"今天"上，且为 0 时不挂', () => {
  assert.match(text(Nav({ view: 'today', pending: 12 })), /今天 ·待判12/)
  const t = text(Nav({ view: 'today', pending: 0 }))
  assert.doesNotMatch(t, /待判/)
  assert.doesNotMatch(text(Nav({ view: 'video', pending: 7 })), /视频 ·待判/)
})

test('点导航格子交出的是视图 id', () => {
  const picked = []
  const items = findAll(Nav({ view: 'today', pending: 0, onPick: (v) => picked.push(v) }), 'bl-navitem')
  items[2].props.onClick()
  assert.deepEqual(picked, ['article'])
})

test('异常带：没问题时什么都不渲染，有问题时逐条说', () => {
  assert.equal(TopBar({ stale: false, runError: '', preferenceErrors: [] }), null)
  const tree = TopBar({ stale: true, runError: 'timeout', preferenceErrors: ['sources[0].url: 要 https'] })
  const t = text(tree)
  assert.match(t, /偏好文件有 1 处问题：sources\[0\]\.url: 要 https/)
  assert.match(t, /宿主接口没答上/)
  assert.match(t, /这一轮没跑成：timeout/)
  assert.equal(tree.props.role, 'alert')
})

test('偏好文件问题超过两条时只念前两条，不把异常带撑成一堵墙', () => {
  const t = text(TopBar({ preferenceErrors: ['a', 'b', 'c', 'd'] }))
  assert.match(t, /偏好文件有 4 处问题/)
  assert.match(t, /a；b/)
  assert.doesNotMatch(t, /c；d/)
})

test('渲染失败的降级块给一句人话，不留白屏', () => {
  assert.match(text(NotReady({ text: '这一格渲染失败：main' })), /这一格渲染失败：main/)
  assert.equal(findAll(NotReady({ text: 'x' }), 'bl-empty').length, 1)
})
