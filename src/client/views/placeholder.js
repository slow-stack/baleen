/**
 * 还没接上真渲染器的部分。规则是"不许把没有的画成有"：文案要点名是哪个里程碑，
 * 且不能出现任何看起来像真内容的东西（不放假标题、不放假简报）。
 * 换成真实现时要把对应导出从这里删掉——留着就是两份同名实现，迟早漂移。
 */
import { vnode } from '../vnode.js'

export function Placeholder({ view, why }) {
  return vnode('div', { className: 'bl-empty-state' }, [`${why}（${view}）`])
}

export const Drawer = () => null
