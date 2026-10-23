/**
 * 面板外壳：顶部导航（门户式五格）+ 全局异常带 + 渲染失败的降级块。
 *
 * 导航是"像网站那样"的主要载体，所以它和视图一样是可测的纯函数——
 * 预览器（tools/preview.mjs）渲染的就是这同一个 Nav，
 * 她看预览时看到的导航布局与真机一致，不是预览里另画一条。
 */
import { vnode } from '../vnode.js'

/** id 与 view-state 的 VIEWS 一字不差；顺序就是点击顺序。 */
export const NAV_ITEMS = [['today', '今天'], ['video', '视频'], ['article', '文章'], ['digest', '汇报'], ['library', '库']]

export function Nav({ view, pending = 0, onPick }) {
  return vnode('nav', { className: 'bl-nav', 'aria-label': '主导航' }, [
    vnode('span', { className: 'bl-brand' }, ['Baleen']),
    vnode('div', { className: 'bl-navlist' }, NAV_ITEMS.map(([id, label]) => vnode('button', {
      type: 'button',
      key: id,
      className: 'bl-navitem',
      'aria-current': view === id ? 'page' : 'false',
      onClick: () => onPick?.(id)
    }, [label + (id === 'today' && pending ? ` ·待判${pending}` : '')])))
  ])
}

/** 全局异常带：偏好文件坏了 / 接口没答上 / 手动那轮失败。没问题时这一格什么都不渲染。 */
export function TopBar({ stale, runError, preferenceErrors }) {
  const bits = []
  if (preferenceErrors && preferenceErrors.length) {
    bits.push(`偏好文件有 ${preferenceErrors.length} 处问题：${preferenceErrors.slice(0, 2).join('；')}`)
  }
  if (stale) bits.push('宿主接口没答上，下面是上次成功时的快照')
  if (runError) bits.push('这一轮没跑成：' + runError)
  if (!bits.length) return null
  return vnode('div', { className: 'bl-band', role: 'alert' }, bits)
}

export function NotReady({ text }) {
  return vnode('div', { className: 'bl-empty' }, [text])
}
