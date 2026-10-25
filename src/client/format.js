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

/**
 * 「读回失败」的统一话术：请求发出去了（甚至 2xx 了），但该读回来的内容没在应答里。
 * 抽屉、收藏页、夹操作三处共用这一句骨架——话术只写一遍，就不会各处漂移成三种说法。
 * 诚实底线：必须明说"没读回来"，不许写成"没有夹""你还没收藏过"那种把失败说成空的谎。
 */
export const readbackMiss = (what) => `${what}没读回来`

/** 收藏这套界面里最常见的一次读回失败：夹列表读不回来，于是整页的收藏关系都无从显示。 */
export const foldersUnreadNote = `读不到夹（${readbackMiss('夹列表')}）`

/**
 * 判断的入口只有一句话：「今天」的待判提示与汇报空态共用这一句——
 * 两处各写一遍的话，迟早漂移成两种说法，用户就得猜哪个才是对的。
 */
export const judgeHint = '对会话说一句「把今天的候选判一下」'
