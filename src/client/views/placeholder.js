/**
 * 未接入视图的占位渲染器。规则是"不许把没有的画成有"：
 * 每一段文案都要点名是哪个里程碑，且不能出现任何看起来像真内容的东西
 * （不放假标题、不放假简报）。后续任务换真实现时，要把对应的导出从这里删掉——
 * 留着就是两份同名实现，迟早漂移。
 */
import { vnode } from '../vnode.js'

export function Placeholder({ view, why }) {
  return vnode('div', { className: 'bl-empty-state' }, [`${why}（${view}）`])
}

export const DigestView = () => Placeholder({ view: 'M3 判断轮', why: '判断轮未接入，所以这里没有图文汇报' })
export const LibraryView = () => Placeholder({ view: 'M2 库任务', why: '库还没接上真渲染器' })
export const Drawer = () => null
