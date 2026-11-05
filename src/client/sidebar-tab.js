/**
 * 侧栏播放 tab 的纯构建层：seed 形状、外链认领、descriptor。
 * 这层不认识宿主也不认识 ctx——装配（真 ctx）留在 _footer，全部可以拿假 service 单测。
 *
 * seed 用 `url` 是实测定的（docs/verification.md 的 M7 探针）：带 `url`/`path` 的 open
 * 走 DSH 原生右侧栏；而面板在前台时两种落点都只会进 pending 队列，所以真正必然可用的
 * 入口是 urlTarget 认领——点链接的时候必然有会话在前台。
 */
import { playerEmbed } from './views/drawer.js'

export const TAB_ID = 'dsh-baleen:player'

/** 认不出来就返回 null：宁可让链接照旧去系统浏览器，也不开一个播不了的门 */
export function parseVideoUrl(raw) {
  let u = null
  try { u = raw instanceof URL ? raw : new URL(String(raw ?? '')) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const embed = playerEmbed(u.href)
  return embed ? { ...embed, url: u.href } : null
}

export function videoTabSeed(url, title = '') {
  return { type: TAB_ID, title: title || 'Baleen 播放', url }
}

/** 原生侧栏把认领来的 URL 挂在页签记录的 path 上（实测 tab18），不是 tab.url */
const urlOf = (tab) => String(tab?.path ?? '')

export function buildTabDescriptor({ render, flags }) {
  return {
    id: TAB_ID,
    title: 'Baleen 播放',
    description: '把 B 站 / YouTube 视频在侧栏里播，不跳平台',
    order: 60,
    single: false,
    dedupeKey: (tab) => TAB_ID + ':' + urlOf(tab),
    urlTarget: (url) => Boolean(flags.takeover()) && Boolean(parseVideoUrl(url)),
    component: (props) => render({ url: urlOf(props?.tab), title: String(props?.tab?.title ?? 'Baleen 播放') })
  }
}

export function registerSidebarTab(service, descriptor) {
  const noop = () => {}
  if (!service || typeof service.registerTab !== 'function') return noop
  try {
    const disposer = service.registerTab(descriptor)
    return typeof disposer === 'function' ? disposer : noop
  } catch (e) {
    console.error('[dsh-baleen] 侧栏 tab 注册失败：' + ((e && e.message) || e))
    return noop
  }
}
