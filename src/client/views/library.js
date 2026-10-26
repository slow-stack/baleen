/**
 * 「库」= 全量检索，含已归档。与另外三格不同，这里的筛选是多选（facet 勾选），
 * 因为查库的人通常在问"判过的里面哪些是不值当的"——单选取一个维度不够。
 * 组内 OR、组间 AND；一个组都没勾 = 不筛。
 */
import { vnode } from '../vnode.js'

export const FACETS = [
  { key: 'status', label: '状态', options: ['new', 'judged', 'digest', 'archived'] },
  { key: 'kind', label: '形态', options: ['article', 'video', 'note'] },
  { key: 'tier', label: '档位', options: ['值得看', '可以看', '不值当'] },
  { key: 'source', label: '来源', options: null }
]
const PAGE = 100

export function libraryRows(items, filters = {}) {
  const allowed = (key, val) => {
    const sel = filters[key]
    return !Array.isArray(sel) || sel.length === 0 || sel.includes(val)
  }
  return (items ?? [])
    .filter((i) => allowed('status', i.status))
    .filter((i) => allowed('kind', i.kind))
    .filter((i) => allowed('tier', i.verdict_tier))
    .filter((i) => allowed('source', i.source_id))
    .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
}

function Facet({ def, options, filters, onFacet }) {
  const sel = Array.isArray(filters[def.key]) ? filters[def.key] : []
  return vnode('div', { className: 'bl-facet', 'data-facet': def.key, key: def.key }, [
    vnode('h4', {}, [def.label]),
    ...options.map((o) => vnode('label', { key: o }, [
      vnode('input', {
        type: 'checkbox',
        'aria-label': `${def.label}：${o}`,
        checked: sel.includes(o),
        onChange: (e) => onFacet?.({ view: 'library', key: def.key, value: o, on: Boolean(e?.target?.checked) })
      }),
      o
    ]))
  ])
}

function Row({ item, onOpen }) {
  const bits = [item.source_id, item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章', item.status]
  if (item.status === 'archived') bits.push(item.archived_reason ? `归档原因：${item.archived_reason}` : '归档原因没记')
  return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
    vnode('span', { className: 'bl-row-meta' }, bits),
    vnode('span', { className: 'bl-row-title' }, [item.title || '（无标题）']),
    item.verdict_tier ? vnode('span', { className: 'bl-tier' }, [`已判：${item.verdict_tier}`]) : null
  ].filter(Boolean))
}

export function LibraryView({ items = [], filters = {}, onFacet, onOpen }) {
  const sources = [...new Set(items.map((i) => i.source_id))]
  const rows = libraryRows(items, filters)
  const shown = rows.slice(0, PAGE)

  return vnode('div', { className: 'bl-library' }, [
    vnode('aside', { className: 'bl-facets' }, FACETS.map((def) => Facet({ def, options: def.options || sources, filters, onFacet }))),
    vnode('div', { className: 'bl-library-body' }, [
      vnode('div', { className: 'bl-count' }, [`${rows.length} 条`]),
      rows.length
        ? vnode('div', { className: 'bl-grid' }, shown.map((i) => Row({ item: i, onOpen })))
        : vnode('p', { className: 'bl-empty' }, [items.length
          ? '这些勾选下没有条目。库里是有东西的——把勾选清一下。'
          : '库里还没有条目。先去「今天」跑一轮。']),
      rows.length > PAGE ? vnode('p', { className: 'bl-more' }, [`还有 ${rows.length - PAGE} 条，翻分页看（这一屏只放 ${PAGE} 条）`]) : null,
      vnode('p', { className: 'bl-note' }, ['改判由会话通过 baleen_save_verdicts 做，这里不放改判按钮；批量归档（M3）尚未接入。'])
    ].filter(Boolean))
  ])
}
