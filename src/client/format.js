/** 面板里共用的格式化。视图不各写一份，否则"同一件事两种写法"又会回来。 */

/** 秒 → 1:02:03 / 18:22；0、负数、非数字一律空串（徽章上留空比显示"0:0"诚实）。 */
export function fmtDuration(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** 时间戳 → 本地可读时间；坏值说"时间未知"而不是显示 Invalid Date。 */
export function fmtTime(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return '（时间未知）'
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(t).toISOString()
  }
}
