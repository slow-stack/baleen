/**
 * 「文章」视图：左列表右正文。这一屏要处理的核心事实是——**"只有摘要"是常态不是故障**：
 * 很多源本来就不吐全文，插件没坏。所以每种 body_state 都要有自己的说法，
 * 尤其不能把"源只给摘要"和"读不到内容"混成一句话（那是两种完全不同的责任）。
 */
import { vnode } from '../vnode.js'
import { reasonOf } from '../match.js'

export const STATE_HINT = {
  full: '',
  summary_only: '这个源只给摘要，全文在原文里',
  subtitle: '来自字幕',
  transcribed: '来自本地转写',
  missing: '读不到内容（没有语音，也没抓到正文）',
  burned_in: '硬字幕读不到（字烧在画面上，不是插件偷懒）'
}
const STATE_OPTIONS = [
  ['full', '全文'], ['summary_only', '仅摘要'], ['subtitle', '字幕'],
  ['transcribed', '转写'], ['missing', '读不到'], ['burned_in', '硬字幕']
]

export function visibleArticles(items, filters = {}) {
  const q = String(filters.q ?? '').trim().toLowerCase()
  return (items ?? []).filter((i) => i.kind === 'article' || i.kind === 'note')
    .filter((i) => !filters.source || i.source_id === filters.source)
    .filter((i) => !filters.state || i.body_state === filters.state)
    .filter((i) => !q || `${i.title ?? ''} ${i.body_text ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
}

/** 面板能读的那部分原文：抓到的是正文就读正文，只有摘要就读摘要，两个都没有就是空。 */
export function readableBody(item) {
  const t = item?.body_text ?? item?.summary_hint ?? ''
  return typeof t === 'string' ? t.trim() : ''
}

export function ArticleView({ items = [], filters = {}, selectedId, onFilter, onSelect, onOpen }) {
  const list = visibleArticles(items, filters)
  const cur = list.find((i) => i.id === selectedId) ?? list[0] ?? null
  const body = cur ? readableBody(cur) : ''
  const sources = [...new Set(items.filter((i) => i.kind !== 'video').map((i) => i.source_id))]

  return vnode('div', { className: 'bl-article' }, [
    vnode('div', { className: 'bl-toolbar' }, [
      vnode('select', {
        'aria-label': '来源', value: filters.source ?? '',
        onChange: (e) => onFilter?.({ view: 'article', key: 'source', value: e?.target?.value ?? '' })
      }, [vnode('option', { value: '' }, ['来源：全部']), ...sources.map((s) => vnode('option', { key: s, value: s }, [s]))]),
      vnode('select', {
        'aria-label': '正文', value: filters.state ?? '',
        onChange: (e) => onFilter?.({ view: 'article', key: 'state', value: e?.target?.value ?? '' })
      }, [vnode('option', { value: '' }, ['正文：全部']), ...STATE_OPTIONS.map(([v, l]) => vnode('option', { key: v, value: v }, [l]))]),
      vnode('input', {
        type: 'search', 'aria-label': '关键词', placeholder: '在这批文章里找',
        value: filters.q ?? '',
        onChange: (e) => onFilter?.({ view: 'article', key: 'q', value: e?.target?.value ?? '' })
      })
    ]),
    vnode('div', { className: 'bl-two' }, [
      vnode('div', { className: 'bl-list', role: 'list' }, list.map((i) => vnode('button', {
        type: 'button', key: i.id, className: 'bl-row',
        'aria-selected': cur && cur.id === i.id ? 'true' : 'false',
        onClick: () => onSelect?.(i.id)
      }, [
        vnode('span', { className: 'bl-row-meta' }, [i.source_id, i.kind === 'note' ? '图文笔记' : '文章']),
        vnode('span', { className: 'bl-row-title' }, [i.title || '（无标题）']),
        vnode('span', { className: 'bl-row-why' }, [reasonOf(i)])
      ]))),
      vnode('article', { className: 'bl-reader', 'aria-live': 'polite' }, cur ? [
        vnode('h4', {}, [cur.title || '（无标题）']),
        vnode('p', { className: 'bl-reader-by' }, [
          `${cur.source_id} · ${cur.author || '未知作者'}`,
          Number(cur.time_estimated) > 0 ? `约 ${Math.round(Number(cur.time_estimated))} 分钟` : ''
        ]),
        STATE_HINT[cur.body_state] ? vnode('p', { className: 'bl-reader-hint' }, [STATE_HINT[cur.body_state]]) : null,
        vnode('div', { className: 'bl-reader-body' }, [body || '（没有正文，只能看原文）']),
        vnode('p', { className: 'bl-reader-link' }, ['读原文：' + (cur.url || '（这条没带链接）')]),
        vnode('button', { type: 'button', className: 'bl-detail', onClick: () => onOpen?.(cur.id) }, ['详情与反馈'])
      ].filter(Boolean) : [
        vnode('p', { className: 'bl-empty' }, ['左边没有条目。多半是这个筛选太窄，或者这一轮还没抓到东西。'])
      ])
    ])
  ])
}
