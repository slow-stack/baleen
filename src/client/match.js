/**
 * 命中理由的读法。预筛入库时把"为什么给你这条"写进 items.match_json，
 * 面板只读不改；坏 JSON 与缺字段一律显式说"没写下理由"——
 * 留空看起来像"这条没有理由"，那是两种不同的事实。
 */
export function reasonOf(item) {
  return matchInfo(item).text || '（无理由）'
}

/** 抽屉里要分开渲染的三样：那句话、命中了哪些词、属于哪个主题组。 */
export function matchInfo(item) {
  let m
  try { m = JSON.parse(item?.match_json ?? '{}') } catch { m = {} }
  if (!m || typeof m !== 'object' || Array.isArray(m)) m = {}
  return {
    text: typeof m.reason === 'string' ? m.reason : '',
    keywords: Array.isArray(m.hitKeywords) ? m.hitKeywords : [],
    groups: Array.isArray(m.groups) ? m.groups : []
  }
}
