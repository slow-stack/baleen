/**
 * 侧栏/工作台里的播放器外壳。与抽屉共用 playerEmbed()——正则抄两遍必然漂移。
 *
 * 这里只读：不收藏、不调权重、不提供"去浏览器"。侧栏手里只有一条 URL，而宿主的
 * /open 只认 item_id（URL 一律从库里取），这条守卫不为了侧栏放宽。
 */
import { vnode } from '../vnode.js'
import { playerEmbed } from './drawer.js'

export function PlayerTab({ url, title = '', crop = true }) {
  const embed = playerEmbed(url)
  if (!embed) {
    return vnode('div', { className: 'bl-tab' }, [
      vnode('p', { className: 'bl-note' }, ['这个地址解析不出嵌入形态，侧栏播不了——回面板抽屉里用「浏览器打开」。'])
    ])
  }
  return vnode('div', { className: 'bl-tab' }, [
    title ? vnode('p', { className: 'bl-tab-title' }, [title]) : null,
    vnode('div', { className: crop ? 'bl-stage bl-stage-crop' : 'bl-stage' }, [
      vnode('iframe', { className: 'bl-player', src: embed.src, allow: 'autoplay; fullscreen', allowfullscreen: true })
    ]),
    vnode('p', { className: 'bl-note' }, [crop
      ? '侧栏只露播放器，下面的推荐流是故意裁掉的——不想让你刷下去。设置页「裁掉推荐区」关掉就还原。'
      : '完整页在这里，往下滑会看到平台的推荐流。'])
  ])
}
