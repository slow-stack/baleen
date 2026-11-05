import test from 'node:test'
import assert from 'node:assert/strict'
import { videoTabSeed, parseVideoUrl, buildTabDescriptor, registerSidebarTab, TAB_ID } from '../src/client/sidebar-tab.js'

test('parseVideoUrl：可嵌入才认，b23.tv 短链和别的站点一律不认（抢了播不了更糟）', () => {
  assert.equal(parseVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3').kind, 'bili')
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ').kind, 'youtube')
  assert.equal(parseVideoUrl('https://b23.tv/x'), null, '短链解析不出 BV 号，不硬猜')
  assert.equal(parseVideoUrl('https://example.invalid/a'), null)
  assert.equal(parseVideoUrl('file:///etc/passwd'), null, '非 http(s) 不碰')
  assert.equal(parseVideoUrl(null), null)
})

test('urlTarget 按契约返回布尔（service.d.ts:217 是 (url: URL) => boolean）', () => {
  const d = buildTabDescriptor({ render: () => null, flags: { takeover: () => true } })
  assert.equal(d.urlTarget(new URL('https://www.bilibili.com/video/BV1GJ411x7h7')), true)
  assert.equal(d.urlTarget(new URL('https://b23.tv/x')), false, '抢下来只会开一个播不了的 tab')
  assert.equal(d.urlTarget(new URL('https://example.invalid/a')), false)
})

test('关掉接管开关后 urlTarget 一律 false，但 tab 本体照旧注册', () => {
  const d = buildTabDescriptor({ render: () => null, flags: { takeover: () => false } })
  assert.equal(d.urlTarget(new URL('https://www.bilibili.com/video/BV1GJ411x7h7')), false)
  assert.equal(typeof d.component, 'function')
})

test('seed 只带 url：实测 openTab({url}) 落原生右侧栏，URL 回来时挂在 tab.path 上', () => {
  const s = videoTabSeed('https://www.bilibili.com/video/BV1GJ411x7h7', '某条视频')
  assert.equal(s.type, TAB_ID)
  assert.equal(s.title, '某条视频')
  assert.equal(s.url, 'https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal('meta' in s, false, 'meta 那条路已被 P3-D 证伪，不留死分支')
})

test('组件从 tab.path 取地址（不是 tab.url），标题用页签自己的 title', () => {
  const seen = []
  const d = buildTabDescriptor({ render: ({ url, title }) => { seen.push([url, title]); return null }, flags: { takeover: () => true } })
  d.component({ tab: { id: 'tab18', type: TAB_ID, title: 'P3-A', path: 'https://www.bilibili.com/video/BV1GJ411x7h7' } })
  assert.deepEqual(seen, [['https://www.bilibili.com/video/BV1GJ411x7h7', 'P3-A']])
})

test('dedupeKey 按 URL 去重：同视频复用 tab，不同视频各开一个', () => {
  const d = buildTabDescriptor({ render: () => null, flags: { takeover: () => true } })
  const tabOf = (u) => ({ id: 'x', type: TAB_ID, title: 't', path: u })
  assert.equal(d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')), d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')))
  assert.notEqual(d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')), d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1B')))
})

test('registerSidebarTab：service 缺席返回空 disposer 且不抛；注册抛错降级为一句诊断', () => {
  assert.equal(typeof registerSidebarTab(null, { id: TAB_ID }), 'function')
  assert.equal(typeof registerSidebarTab(undefined, { id: TAB_ID }), 'function')
  const boom = registerSidebarTab({ registerTab() { throw new Error('宿主没准备好') } }, { id: TAB_ID })
  assert.equal(typeof boom, 'function')
  boom()
  let called = 0
  const ok = registerSidebarTab({ registerTab: (d) => { called++; assert.equal(d.id, TAB_ID); return () => called-- } }, { id: TAB_ID })
  assert.equal(called, 1)
  ok()
  assert.equal(called, 0, 'disposer 必须转交 service 给的那个，注册才算可回收')
})
