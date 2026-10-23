/**
 * 「视频」视图。这一屏的诚实点在两处：
 *  1. 档位只有三个词，没判过的就是"待判"，不许用预筛得分冒充结论；
 *  2. 能不能播按源说清楚——只有 B 站打算内嵌，其余一律跳转，不画播放键骗人。
 */
import { vnode } from '../vnode.js'
import { reasonOf } from '../match.js'

export const TIER_LABELS = { '值得看': 'good', '可以看': 'ok', '不值当': 'bad' }
const STATE_LABELS = {
  full: '全文', summary_only: '仅摘要', subtitle: '字幕',
  transcribed: '转写', missing: '无语音', burned_in: '硬字幕读不到'
}

export function fmtDuration(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export function visibleVideos(items, filters = {}) {
  const q = String(filters.q ?? '').trim().toLowerCase()
  return (items ?? []).filter((i) => i.kind === 'video')
    .filter((i) => !filters.tier || i.verdict_tier === filters.tier)
    .filter((i) => !filters.source || i.source_id === filters.source)
    .filter((i) => !q || `${i.title ?? ''} ${i.author ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.prefilter_score ?? 0) - (a.prefilter_score ?? 0))
}

function Picker({ label, filterKey, view, options, value, onFilter }) {
  return vnode('select', {
    'aria-label': label,
    value: value ?? '',
    onChange: (e) => onFilter?.({ view, key: filterKey, value: e?.target?.value ?? '' })
  }, [
    vnode('option', { value: '' }, [`${label}：全部`]),
    ...options.map((o) => vnode('option', { key: o, value: o }, [o]))
  ])
}

function VideoCard({ item, onOpen }) {
  return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
    vnode('span', { className: 'bl-thumb' }, [vnode('span', { className: 'bl-dur' }, [fmtDuration(item.duration_sec) || '—'])]),
    vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
    vnode('span', { className: 'bl-card-meta' }, [
      item.author || item.source_id,
      STATE_LABELS[item.body_state] ?? item.body_state ?? ''
    ]),
    vnode('span', { className: 'bl-tier' }, [item.verdict_tier ? `${item.verdict_tier}：${item.verdict_why || '（这条没写理由）'}` : '待判']),
    vnode('span', { className: 'bl-why' }, [reasonOf(item)]),
    vnode('span', { className: 'bl-play' }, [item.source_id === 'bili' ? '可在抽屉内播' : '只能跳转'])
  ])
}

export function VideoView({ items = [], filters = {}, onFilter, onOpen }) {
  const all = (items ?? []).filter((i) => i.kind === 'video')
  const list = visibleVideos(items, filters)
  const sources = [...new Set(all.map((i) => i.source_id))]
  const judged = list.filter((i) => i.status === 'judged').length

  return vnode('div', { className: 'bl-video' }, [
    vnode('div', { className: 'bl-toolbar' }, [
      Picker({ label: '档位', filterKey: 'tier', view: 'video', options: Object.keys(TIER_LABELS), value: filters.tier, onFilter }),
      Picker({ label: '平台', filterKey: 'source', view: 'video', options: sources, value: filters.source, onFilter }),
      vnode('input', {
        type: 'search', 'aria-label': '关键词', placeholder: '在这批视频里找',
        value: filters.q ?? '',
        onChange: (e) => onFilter?.({ view: 'video', key: 'q', value: e?.target?.value ?? '' })
      })
    ]),
    vnode('div', { className: 'bl-count' }, [`显示 ${list.length} / ${all.length} 条（判过 ${judged} 条）`]),
    list.length
      ? vnode('div', { className: 'bl-grid' }, list.map((i) => VideoCard({ item: i, onOpen })))
      : vnode('div', { className: 'bl-empty' }, [all.length
        ? '这个筛选下没有东西。库里有货但没显示出来时，通常是档位或平台筛过了——把筛选清一下。'
        : '库里还没有视频。B 站与小红书视频笔记在 M4 接入；现在订阅的都是文章源的话，这里就该是空的。'])
  ])
}
