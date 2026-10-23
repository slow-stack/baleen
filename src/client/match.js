/**
 * 命中理由的读法。预筛入库时把"为什么给你这条"写进 items.match_json，
 * 面板只读不改；坏 JSON 与缺字段一律显示"（无理由）"——留空看起来像"没有理由"，
 * 而真实情况是"这条没写下理由"，两者不能混。
 */
export function reasonOf(item) {
  try {
    const m = JSON.parse(item?.match_json ?? '{}')
    return typeof m.reason === 'string' && m.reason ? m.reason : '（无理由）'
  } catch { return '（无理由）' }
}
