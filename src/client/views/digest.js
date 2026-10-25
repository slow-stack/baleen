/**
 * 「汇报」视图。M3 起这里展示判断轮真实落库的汇报（最近 5 条，倒序）；
 * 没有内容时唯一的责任仍是**把"为什么没有"说清楚**：
 * 是没跑过、还是接入了但还没判过、还是库里明明有汇报但面板没读到。
 * 三种情况写法不同，绝不拿假摘要填版面。
 */
import { vnode } from '../vnode.js'
import { fmtTime, judgeHint } from '../format.js'

/**
 * @param state  宿主 /state 的返回（要 digest_count、counts.new、last_run）
 * @param loaded 面板手里真正拿到的汇报份数
 */
export function digestEmptyReason(state, loaded) {
  if (loaded > 0) return ''
  const total = Number(state?.digest_count) || 0
  if (total > 0) return `库里有 ${total} 份汇报，但面板没读到汇报内容——这一格现在数得出，读不出来。`
  if (!state || !state.last_run) return '还没跑过一轮：库是空的。去「今天」点"现在跑一轮"，或者等定时窗口自己起。'
  const pending = Number(state?.counts?.new) || 0
  return `判断轮已接入，但还没有跑过判断${pending ? `：库里待判 ${pending} 条` : ''}。${judgeHint}，判完这里就出汇报。`
}

/**
 * tiers 计数行：数字与 headline 同源（都出自 saveVerdicts 落的 stats）。
 * stats 缺了或没解出来就明说"没读出来"，不装作没有这一栏——那是把读回失败说成空。
 */
export function digestTierLine(stats) {
  const t = stats?.tiers
  if (!t) return '（这份汇报的计数没读出来）'
  return `值得看 ${Number(t['值得看']) || 0} · 可以看 ${Number(t['可以看']) || 0} · 不值当 ${Number(t['不值当']) || 0}`
}

export function DigestView({ digests = [], state }) {
  const reason = digestEmptyReason(state, digests.length)
  if (reason) return vnode('div', { className: 'bl-digest bl-empty-state' }, [reason])
  const sorted = [...digests].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  return vnode('div', { className: 'bl-digest' }, sorted.map((d) => vnode('section', { className: 'bl-dsum', key: d.id }, [
    vnode('h3', {}, [fmtTime(d.created_at)]),
    vnode('p', { className: 'bl-dhead' }, [d.headline || '（这份简报没写标题）']),
    vnode('p', { className: 'bl-dtiers' }, [digestTierLine(d.stats)])
  ])))
}
