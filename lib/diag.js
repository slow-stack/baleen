import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
// 凭据值一直吃到 , 或 ; 为止："Bearer a.b c" 里的 c 也算值的一部分，
// 只遮第一个 token 等于没遮。
const SECRET_KEY = /((?:authorization|cookie|set-cookie|token|secret|password|api[-_]?key|credential)\s*[:=]\s*)([^,;]*)/gi
// 盘符路径要求前面不是字母数字，否则 https:// 里的 "s://" 会被当成路径整段吃掉。
const WIN_PATH = /(^|[^A-Za-z0-9])([A-Za-z]):[\\/][^\s"'<>|]*/g

/**
 * 日志与诊断包在出去之前都要过这里。规则是"宁可多遮一点"：
 * 家目录、盘符路径、凭据值一律替换掉，其余内容原样留着——
 * 排查问题靠的就是错误原文，遮太多等于没有日志。
 */
export function redact(str) {
  let out = String(str ?? '')
  if (HOME) out = out.split(HOME).join('<HOME>')
  out = out.replace(SECRET_KEY, (m, head) => `${head}<REDACTED>`)
  out = out.replace(WIN_PATH, (m, pre) => `${pre}<PATH>`)
  return out
}

const MAX_LINE = 400

export function makeLogger({ dir, file, now = Date.now, append = (f, s) => fs.appendFileSync(f, s, 'utf8'), sink } = {}) {
  const target = file ?? (dir ? path.join(dir, 'logs', 'diagnostics.jsonl') : null)
  if (target) {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }) } catch { /* 建不了目录就只走 sink */ }
  }
  return (entry) => {
    const e = {
      at: entry?.at ?? now(),
      level: entry?.level ?? 'info',
      event: entry?.event ?? 'log',
      detail: redact(String(entry?.detail ?? '')).slice(0, 240),
      source_id: entry?.source_id ?? null,
      run_id: entry?.run_id ?? null
    }
    if (sink) sink(e)
    if (!target) return
    const line = JSON.stringify(e) + '\n'
    if (line.length > MAX_LINE) return
    try {
      append(target, line)
    } catch { /* 日志失败绝不影响抓取 */ }
  }
}
