/**
 * 侧栏/工作台里的播放器外壳。与抽屉共用 playerEmbed() 与 playerStage()——
 * 嵌入正则和舞台标记抄两遍必然漂移。
 *
 * 这里只读：不收藏、不调权重、不提供"去浏览器"。侧栏手里只有一条 URL，而宿主的
 * /open 只认 item_id（URL 一律从库里取），这条守卫不为了侧栏放宽。
 * 音量/倍速在跨源 iframe 里面，我们够不着——界面上明说用画面里的原播放器控件，
 * 不摆假滑杆。裁切窗跟容器宽度走（aspect-ratio 16:9），B 站完整页多一层页头偏移，
 * 让视频面精确填满窗口、控制条完整可见（css.js 的 .bl-stage-* 一族）。
 */
import { vnode } from '../vnode.js'
import { playerEmbed, playerStage } from './drawer.js'

const KIND_LABEL = { bili: 'B 站', youtube: 'YouTube' }

export function PlayerTab({ url, title = '', crop = true }) {
  const embed = playerEmbed(url)
  if (!embed) {
    return vnode('div', { className: 'bl-tab' }, [
      vnode('p', { className: 'bl-note' }, ['这个地址解析不出嵌入形态，侧栏播不了——回面板抽屉里用「浏览器打开」。'])
    ])
  }
  return vnode('div', { className: 'bl-tab' }, [
    title ? vnode('p', { className: 'bl-tab-head' }, [
      vnode('span', { className: 'bl-badge' }, [KIND_LABEL[embed.kind] || '视频']),
      vnode('span', { className: 'bl-tab-title' }, [title])
    ]) : null,
    playerStage(embed, crop),
    vnode('p', { className: 'bl-note' }, [crop
      ? '只露播放器本体：推荐流被裁掉，是不想让你顺着刷下去；音量、倍速用画面里的原播放器控件。设置页「裁掉推荐区」关掉就还原完整页。'
      : '完整页在这里，往下滑会看到平台的推荐流。'])
  ])
}
