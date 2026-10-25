/**
 * yt-captions.js —— YouTube 字幕轨解析器（json3 / vtt），纯函数、零依赖、可独立测试。
 *
 *  - parseJson3：timedtext API 的 json3 形态（{"events":[{"segs":[{"utf8":...}]}]}）。
 *    逐 event 拼 utf8 段、剥换行 seg、跳过无 segs 的纯时间事件。
 *  - parseVtt：vtt 兜底——去头部/cue 标识行/时间轴/行内标签/NOTE 块，解码基础实体，
 *    滚动字幕的连续重复行去重。够用就好，不做布局（对齐/位置）语义。
 *  - 契约：两者都吃原始响应文本，产出 '\n' 连接的纯文本；解析不出返回 ''
 *    （调用方按"没拿到字幕"处理，绝不把残缺结构当成字幕文本）。
 */

/** json3 → 纯文本。事件里的多个 seg 直接相连（同一屏的字），事件之间换行。 */
export function parseJson3(text) {
  let json
  try { json = JSON.parse(String(text ?? '')) } catch { return '' }
  const events = Array.isArray(json?.events) ? json.events : []
  const lines = []
  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue // 纯时间标记事件，没有文本
    const t = ev.segs.map(s => String(s?.utf8 ?? '')).join('').replace(/\r/g, '')
    for (const piece of t.split('\n')) {
      const line = piece.trim()
      if (line) lines.push(line)
    }
  }
  return lines.join('\n')
}

const VTT_HEAD_RE = /^(WEBVTT|STYLE|REGION|Kind:|Language:)/i
const VTT_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

/** vtt → 纯文本。极简解析：结构行全部剔除，正文行剥标签、解码实体、滚动去重。 */
export function parseVtt(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let inNote = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) { inNote = false; continue }
    if (inNote) continue
    if (/^NOTE\b/i.test(line)) { inNote = true; continue } // NOTE 块到空行为止
    if (lines[i + 1]?.includes('-->')) continue // cue 标识行（下一行是时间轴）
    if (line.includes('-->')) continue // 时间轴行
    if (VTT_HEAD_RE.test(line)) continue // 文件头与块声明
    const clean = line
      .replace(/<[^>]*>/g, '') // <v Roger> / <c.yellow> 等行内标签
      .replace(/&\w+;|&#\d+;/g, m => VTT_ENTITIES[m] ?? ' ')
      .trim()
    if (!clean) continue
    if (out[out.length - 1] !== clean) out.push(clean) // 滚动字幕的连续重复行
  }
  return out.join('\n')
}
