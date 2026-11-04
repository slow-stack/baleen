import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerTab } from '../src/client/views/player-tab.js'
import { text, findAll } from './helpers/tree.mjs'

test('B 站可嵌入：侧栏 tab 画播放器，裁切时容器是 bl-stage-crop', () => {
  const t = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '某条视频', crop: true })
  assert.equal(findAll(t, 'bl-player').length, 1)
  assert.equal(findAll(t, 'bl-stage-crop').length, 1, '裁切容器必须在，否则推荐流露出来')
  assert.match(findAll(t, 'bl-player')[0].props.src, /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7$/)
  assert.match(text(t), /某条视频/)
})

test('关掉裁切：容器不带 bl-stage-crop，文案如实说会看到推荐流', () => {
  const t = PlayerTab({ url: 'https://youtu.be/dQw4w9WgXcQ', crop: false })
  assert.equal(findAll(t, 'bl-stage-crop').length, 0)
  assert.match(text(t), /推荐流/)
})

test('解析不出嵌入形态（含 b23.tv 短链）不画播放器，只说一句真话', () => {
  for (const url of ['https://b23.tv/x', 'https://example.invalid/a', '']) {
    const t = PlayerTab({ url })
    assert.equal(findAll(t, 'bl-player').length, 0, url)
    assert.match(text(t), /解析不出嵌入形态/)
  }
})

test('侧栏 tab 里没有收藏、没有调权重、没有"去浏览器"', () => {
  const s = text(PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }))
  assert.doesNotMatch(s, /收藏|不感兴趣|这源多来点|浏览器打开/)
})
