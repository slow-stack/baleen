/**
 * 面板视图状态。纯函数，不碰 window、不发请求——所以能在 Node 里测完。
 * 每个视图的筛选各存各的：从视频区带着"档位=值得看"切去文章区，
 * 回来时那个筛选还在，但不会污染文章区的筛选。
 */
export const VIEWS = ['today', 'video', 'article', 'digest', 'library']

const DEFAULT_STATE = () => ({ view: 'today', filters: {}, drawerItemId: null, selectedId: null, scroll: 0 })

/** 首屏状态。持久化的读法在 decodeState（装配层把 localStorage 里的原文交给它）。 */
export function initialView() {
  return decodeState()
}

export function reduce(state, action) {
  const s = state ?? DEFAULT_STATE()
  switch (action?.type) {
    case 'pick-view':
      return VIEWS.includes(action.view) ? { ...s, view: action.view } : s
    case 'filter': {
      if (!action.view || !action.key) return s
      const perView = { ...(s.filters[action.view] ?? {}) }
      if (action.value === '' || action.value === null || action.value === undefined) delete perView[action.key]
      else perView[action.key] = action.value
      return { ...s, filters: { ...s.filters, [action.view]: perView } }
    }
    case 'facet': {
      // 「库」的多选筛选：组内 OR，勾满再取消就删键（等价于"不筛"），不留空数组占位
      if (!action.view || !action.key || action.value == null) return s
      const perView = { ...(s.filters[action.view] ?? {}) }
      const cur = Array.isArray(perView[action.key]) ? perView[action.key] : []
      const next = action.on ? [...new Set([...cur, action.value])] : cur.filter((v) => v !== action.value)
      if (next.length) perView[action.key] = next
      else delete perView[action.key]
      return { ...s, filters: { ...s.filters, [action.view]: perView } }
    }
    case 'open-drawer':
      return action.id == null ? s : { ...s, drawerItemId: action.id }
    case 'select': {
      const id = action.id == null ? null : Number(action.id)
      return { ...s, selectedId: Number.isInteger(id) ? id : null }
    }
    case 'close-drawer':
      return { ...s, drawerItemId: null }
    case 'scroll':
      return { ...s, scroll: Number(action.top) || 0 }
    default:
      return s
  }
}

export function encodeState(state) {
  try {
    return JSON.stringify({ v: 1, view: state.view, filters: state.filters, drawerItemId: state.drawerItemId, selectedId: state.selectedId, scroll: state.scroll })
  } catch { return '' }
}

/**
 * localStorage 里可能是上次崩溃留下的半成品、也可能是旧版本写的结构，
 * 所以一律回落默认而不是抛——抛在 apply() 里会炸整个客户端装配。
 */
export function decodeState(text) {
  const base = DEFAULT_STATE()
  if (!text) return base
  let obj
  try { obj = JSON.parse(text) } catch { return base }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return base
  const filters = {}
  if (obj.filters && typeof obj.filters === 'object' && !Array.isArray(obj.filters)) {
    for (const [k, v] of Object.entries(obj.filters)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) filters[k] = { ...v }
    }
  }
  return {
    view: VIEWS.includes(obj.view) ? obj.view : base.view,
    filters,
    drawerItemId: Number.isInteger(obj.drawerItemId) ? obj.drawerItemId : null,
    selectedId: Number.isInteger(obj.selectedId) ? obj.selectedId : null,
    scroll: Number.isFinite(obj.scroll) ? obj.scroll : 0
  }
}
