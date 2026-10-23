/**
 * 「汇报」视图。M3 之前这里必然没有内容，所以这一屏唯一的责任是**把"为什么没有"说清楚**：
 * 是没跑过、还是判断轮没接入、还是库里明明有汇报但面板还读不到。
 * 三种情况写法不同，绝不拿假摘要填版面。
 */
import { vnode } from '../vnode.js'

export function digestTime(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return '（时间未知）'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(t).toISOString()
  }
}

/**
 * @param state  宿主 /state 的返回（要 digest_count、counts.new、last_run）
 * @param loaded 面板手里真正拿到的汇报份数
 */
export function digestEmptyReason(state, loaded) {
  if (loaded > 0) return ''
  const total = Number(state?.digest_count) || 0
  if (total > 0) return `库里有 ${total} 份汇报，但面板还没接上汇报读取——这一格现在数得出，读不出来。`
  if (!state || !state.last_run) return '还没跑过一轮：库是空的。去「今天」点"现在跑一轮"，或者等定时窗口自己起。'
  return `判断轮（M3）尚未接入，所以这里没有图文汇报。当前待判 ${Number(state?.counts?.new) || 0} 条已经躺在库里，等有会话跑一轮就能出。`
}

export function DigestView({ digests = [], state }) {
  const reason = digestEmptyReason(state, digests.length)
  if (reason) return vnode('div', { className: 'bl-digest bl-empty-state' }, [reason])
  const sorted = [...digests].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  return vnode('div', { className: 'bl-digest' }, sorted.map((d) => vnode('section', { className: 'bl-dsum', key: d.id }, [
    vnode('h3', {}, [digestTime(d.created_at)]),
    vnode('p', { className: 'bl-dhead' }, [d.headline || '（这份简报没写标题）']),
    vnode('p', { className: 'bl-dpath' }, ['原文：' + (d.markdown_path || '（未落文件）')])
  ])))
}
