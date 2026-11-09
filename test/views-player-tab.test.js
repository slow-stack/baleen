import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerTab } from '../src/client/views/player-tab.js'
import { text, findAll } from './helpers/tree.mjs'

test('B 站完整页：裁切窗精确合围视频面，容器带 bl-stage-bili（页头偏移只归它）', () => {
  const t = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '某条视频', crop: true })
  assert.equal(findAll(t, 'bl-player').length, 1)
  const stage = findAll(t, 'bl-stage')[0]
  assert.equal(stage.props.className, 'bl-stage bl-stage-crop bl-stage-bili',
    'B 站是完整页 iframe：裁切窗之外还要页头偏移，控制条（音量在那）才完整落在窗内')
  assert.match(findAll(t, 'bl-player')[0].props.src, /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7$/)
  assert.match(text(t), /某条视频/)
})

test('YouTube embed：裁切窗精确合围，不带页头偏移；rel=0 让播完不出相关视频网格', () => {
  const t = PlayerTab({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', crop: true })
  const stage = findAll(t, 'bl-stage')[0]
  assert.equal(stage.props.className, 'bl-stage bl-stage-crop',
    'YouTube embed 本来就是纯 16:9 播放器，不需要页头偏移')
  assert.match(findAll(t, 'bl-player')[0].props.src, /\/embed\/dQw4w9WgXcQ\?rel=0/)
})

test('标题行带平台徽标，一眼知道这是谁家的页面', () => {
  const bili = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '某条视频' })
  assert.equal(text(findAll(bili, 'bl-badge')[0]), 'B 站')
  const yt = PlayerTab({ url: 'https://youtu.be/dQw4w9WgXcQ', title: '另一条' })
  assert.equal(text(findAll(yt, 'bl-badge')[0]), 'YouTube')
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

test('音量归画面里的原播放器控件：跨源 iframe 我们够不着，这话要说在界面上', () => {
  const t = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })
  assert.match(text(t), /音量/)
  assert.match(text(t), /原播放器|播放器.*控件/)
})
