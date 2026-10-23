import { cleanUrl } from './feed.js'
import { getItemByKey, findByUrl, findByTitleNorm, insertItem, refreshItem, setStatus } from './store.js'

const WINDOW = 14 * 86400000
const MIN_TITLE_NORM = 8

/**
 * 去掉空白与标点做比较键。"转载时改个问号/加个空格"是最常见的重复形态，
 * 但短到两三个字的标题（"教程"）不配参与查重，否则会把一片正常内容误吞掉。
 */
export function normalizeTitle(t) {
  return String(t ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 120)
}

export function findDuplicate(db, draft, now = Date.now) {
  const since = Number(now()) - WINDOW
  const cu = cleanUrl(draft.url)
  if (cu) {
    const hit = findByUrl(db, cu, since)
    if (hit) return { id: hit.id, why: `url:${cu}` }
  }
  const norm = normalizeTitle(draft.title)
  if (norm.length >= MIN_TITLE_NORM) {
    const hit2 = findByTitleNorm(db, norm, since, draft.author ?? null)
    if (hit2) return { id: hit2.id, why: 'title-author' }
  }
  return null
}

/**
 * 入库唯一入口。四种结果：
 *   insert     新条目
 *   update     同键同条目、还没判过 → 刷新正文与得分，状态回到 new
 *   skip_seen  已经判过 / 已因别的理由归档 → 一个字都不改（不重复消耗判断预算）
 *   duplicate  另一条已存在（同 URL 或同标题同作者）→ 插入后立即归档，留下可追溯的记录
 * duplicate 走"插入再归档"而不是丢弃，是为了让"我今天少看了什么"能被回查。
 */
export function putDraft(db, draft, now = Date.now) {
  const norm = normalizeTitle(draft.title)
  // url 在这一层归一化，而不是指望每个适配器都记得清参数：
  // 库里存了带 utm 的 URL，URL 级查重就会**静默失效**（实测过一次），
  // 而"看起来在工作、其实没去重"是最难发现的一类 bug。
  const url = cleanUrl(draft.url) ?? draft.url
  const row = { ...draft, url, title_norm: norm.length >= MIN_TITLE_NORM ? norm : null }
  const key = getItemByKey(db, row.source_id, row.external_id)

  if (key) {
    if (key.status === 'judged' || key.status === 'digest') return { id: key.id, action: 'skip_seen' }
    if (key.status === 'archived' && !String(key.archived_reason ?? '').startsWith('duplicate')) {
      return { id: key.id, action: 'skip_seen', reason: `archived:${key.archived_reason}` }
    }
    refreshItem(db, key.id, row, 'new')
    return { id: key.id, action: 'update' }
  }

  const dup = findDuplicate(db, row, now)
  if (dup) {
    const id = insertItem(db, row)
    setStatus(db, id, 'archived', `duplicate:${dup.why}`)
    return { id, action: 'duplicate', reason: dup.why }
  }
  return { id: insertItem(db, row), action: 'insert' }
}
