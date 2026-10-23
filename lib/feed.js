/**
 * feed.js —— RSS2 / Atom 文本 → 结构的容错解析器。
 *
 * 为什么不用现成库：feed 的脏数据（缺字段、坏日期、CDATA 里嵌标签、双重转义）
 * 才是主要工作量，而这些正是要测的东西；拿库来会把这层行为变成黑盒。
 * 这里只做"取字段"，不做 HTML 清洗之外的任何判断（判断在 normalize / prefilter）。
 */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const TRACKING = /^(utm_|_ga$|_gl$|mc_|ref$|source$|fbclid$|gclid$|igshid$)/i
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function decode(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m
    }
    const k = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m
  })
}

export function stripTags(html) {
  if (html == null) return ''
  const noScript = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  return decode(noScript.replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapCdata(v) {
  const t = String(v).trim()
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t)
  return m ? m[1] : t
}

/** 找到 from 之后第 depth 层同名闭合标签的位置，正确处理同名嵌套 */
function closeIndex(text, from, tag) {
  const openRe = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>`, 'gi')
  const closeRe = new RegExp(`</${esc(tag)}\\s*>`, 'gi')
  openRe.lastIndex = from
  closeRe.lastIndex = from
  let depth = 1
  while (true) {
    const c = closeRe.exec(text)
    if (!c) return -1
    const o = openRe.exec(text)
    if (o && o.index < c.index) {
      depth++
      openRe.lastIndex = o.index + 1
      closeRe.lastIndex = c.index + 1
      continue
    }
    depth--
    if (depth === 0) return c.index
    closeRe.lastIndex = c.index + 1
  }
}

function blocks(text, tag) {
  const out = []
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>`, 'gi')
  let m
  while ((m = re.exec(text))) {
    const innerStart = m.index + m[0].length
    const innerEnd = closeIndex(text, innerStart, tag)
    if (innerEnd < 0) { re.lastIndex = innerStart; continue }
    out.push(text.slice(innerStart, innerEnd))
    re.lastIndex = innerEnd + tag.length + 3
  }
  return out
}

/** 取标签内的原始文本（CDATA 已剥壳），没有闭合形态时返回 null */
function field(block, tag) {
  const m = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'i').exec(block)
  return m ? unwrapCdata(m[1]) : null
}

function textOf(block, ...tags) {
  for (const t of tags) {
    const raw = field(block, t)
    if (raw != null) {
      const s = stripTags(raw)
      if (s !== '') return s
    }
  }
  return null
}

function htmlOf(block, ...tags) {
  for (const t of tags) {
    const raw = field(block, t)
    if (raw != null && raw.trim() !== '') return decode(raw)
  }
  return null
}

function allTags(block, tag) {
  const out = []
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'gi')
  let m
  while ((m = re.exec(block))) {
    const term = /\bterm\s*=\s*"([^"]*)"/i.exec(m[0])
    const v = term ? decode(term[1]) : stripTags(unwrapCdata(m[1]))
    if (v) out.push(v)
  }
  return out
}

export function parseDuration(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').filter(Boolean)
  if (!parts.length || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null
  let sec = 0
  for (const n of parts.map(Number)) sec = sec * 60 + n
  return Math.round(sec)
}

function parseDate(v) {
  if (!v) return null
  const s = String(v).trim()
  const direct = Date.parse(s)
  if (Number.isFinite(direct)) return direct
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) return null
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}Z`)
  return Number.isFinite(t) ? t : null
}

export function cleanUrl(u) {
  if (!u) return null
  const noFrag = String(u).trim().split('#')[0]
  if (!/[?&]/.test(noFrag)) return noFrag.replace(/\/$/, '')
  const [base, qs] = noFrag.split('?')
  const kept = qs.split('&').filter(kv => kv && !TRACKING.test(kv.split('=')[0]))
  return (kept.length ? `${base}?${kept.join('&')}` : base).replace(/\/$/, '')
}

function pickLink(block) {
  const rss = field(block, 'link')
  if (rss != null && stripTags(rss) !== '') return cleanUrl(stripTags(rss))
  const tags = block.match(/<link\b[^>]*>/gi) || []
  let fallback = null
  for (const tag of tags) {
    const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(tag)
    if (!href) continue
    const url = decode(href[1] ?? href[2])
    const rel = /\brel\s*=\s*"([^"]*)"/i.exec(tag)
    if (!rel || rel[1] === 'alternate') return cleanUrl(url)
    fallback ??= cleanUrl(url)
  }
  return fallback
}

function pickThumb(block, bodyHtml) {
  const m = /<(?:media:thumbnail|thumbnail)\b[^>]*\burl\s*=\s*"([^"]*)"/i.exec(block)
    || /<image\b[^>]*>[\s\S]*?<url>([^<]*)<\/url>/i.exec(block)
  if (m) return decode(m[1])
  const img = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(bodyHtml || '')
  return img ? decode(img[1]) : null
}

export function parseFeed(xml) {
  const text = String(xml ?? '')
  const isAtom = /<feed[\s>]/i.test(text)
  const isRss = /<rss[\s>]/i.test(text)
  const format = isAtom ? 'atom' : isRss ? 'rss' : 'unknown'
  const feedTitle = textOf(text, 'title')
  const rawItems = isAtom ? blocks(text, 'entry') : isRss ? blocks(text, 'item') : []

  const items = rawItems.map(b => {
    const bodyHtml = htmlOf(b, isAtom ? 'content' : 'content:encoded')
    const summaryHtml = htmlOf(b, 'description', 'summary')
    const url = pickLink(b)
    const guid = textOf(b, 'guid', 'id')
    return {
      external_id: guid || url || null,
      url,
      title: textOf(b, 'title'),
      author: isAtom
        ? textOf(/<author[\s\S]*?<\/author>/i.exec(b)?.[0] ?? '', 'name') ?? textOf(b, 'author', 'name')
        : textOf(b, 'author', 'dc:creator', 'creator'),
      published_at: parseDate(textOf(b, 'pubDate', 'published', 'updated', 'dc:date', 'date')),
      body_html: bodyHtml,
      summary_html: summaryHtml && summaryHtml !== bodyHtml ? summaryHtml : null,
      thumb: pickThumb(b, bodyHtml),
      duration_sec: parseDuration(textOf(b, 'itunes:duration', 'duration')),
      tags: [...new Set([...allTags(b, 'category'), ...allTags(b, 'media:keywords')])]
    }
  }).filter(i => i.title && (i.url || i.external_id))

  return { format, feed_title: feedTitle, items }
}
