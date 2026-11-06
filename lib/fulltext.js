/**
 * fulltext.js —— 从原文页面抽正文，补「RSS 只给摘要」这个缺口。
 *
 * 为什么手写而不是引库：Readability 那一套是几万行加依赖，而这里只需要
 * 「article/main/body 里挑一个容器、丢掉评论区与推荐区、收 p/h2/h3/li」。
 * 判据是**宁可抽不到，也不要把评论区当正文**：抽出来太短就返回空串，
 * 调用方据此保留原来的摘要——把评论与推荐当正文，比只读摘要更糟。
 */

import { stripTags } from './feed.js'

export const FULLTEXT_MIN_CHARS = 400

// 整块连内容一起丢：这些标签里要么是脚本样式，要么是页面框架，从来不是正文
const DROP_TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'header', 'footer', 'nav', 'aside']
// 正文容器内按 class/id 判噪音（评论、分享、相关推荐、订阅、面包屑……）
const NOISE_RE = /comment|share|related|recommend|sidebar|footer|nav|advert|promo|subscribe|newsletter|cookie|breadcrumb|social|toolbar/i
// 只认这四类段落标签。div 里也常有正文，但 div 也常有导航和页脚——认它等于把噪音请回来
const SEG_OPEN_RE = /<(p|h2|h3|li)\b[^>]*>/gi

/**
 * 找到 from 之后与 start 处同名开标签配对的闭合标签位置（同名嵌套按深度算）。
 * 正则非贪婪在 `<div class="comments"><div class="comments">…</div></div>` 上会切在内层
 * 闭合处，把外层剩下的正文一起吞掉，所以这里必须数深度。
 */
function closeIndex(text, from, tag) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')
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

/**
 * 把某个标签的整块（含内容）剪掉。
 * 没闭合时只剪开标签本身、内容留着——脚本样式整块丢是对的，
 * 但一个坏页面不该因为少了一个 </header> 就把全文一起吞掉。
 */
function dropBlocks(text, tag) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')
  let out = ''
  let cursor = 0
  let m
  while ((m = openRe.exec(text))) {
    const end = closeIndex(text, m.index + m[0].length, tag)
    if (end < 0) continue
    out += text.slice(cursor, m.index) + ' '
    cursor = end + tag.length + 3
    openRe.lastIndex = cursor
  }
  return out + text.slice(cursor)
}

/** 取 class 或 id 的原文（单双引号都认，无引号的值也收） */
function attrOf(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

/**
 * 容器内按 class/id 丢噪音块：一次只剪一个命中，剪完从同一位置继续，
 * 嵌套的随外层一起消失。先剪外层再扫内层，所以不会出现「父元素文字被连带丢掉」。
 */
function dropNoise(text) {
  const re = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s[^>]*)?)>/g
  let out = ''
  let cursor = 0
  let m
  while ((m = re.exec(text))) {
    const attrs = m[2] ?? ''
    if (!NOISE_RE.test(`${attrOf(attrs, 'class')} ${attrOf(attrs, 'id')}`)) continue
    const end = closeIndex(text, m.index + m[0].length, m[1])
    out += text.slice(cursor, m.index) + ' '
    if (end < 0) {
      // 自闭合或没闭合（img/br 一类）：只剪开标签，后面照常扫
      cursor = m.index + m[0].length
      re.lastIndex = cursor
      continue
    }
    cursor = end + m[1].length + 3
    re.lastIndex = cursor
  }
  return out + text.slice(cursor)
}

/** 正文容器：优先 article，其次 main，再次 body；都没闭合就退回全文 */
function pickContainer(html) {
  for (const tag of ['article', 'main', 'body']) {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i').exec(html)
    if (!m) continue
    const end = closeIndex(html, m.index + m[0].length, tag)
    if (end < 0) continue
    return html.slice(m.index + m[0].length, end)
  }
  return html
}

/**
 * 收段落文字。闭合的取配对区间；HTML 允许省略 </p>，没闭合的取到下一个段落开标签为止
 * （真实博客里 `<p>甲<p>乙</p>` 这种写法比想象的常见，整段吞掉就等于白抓）。
 */
function collectSegments(text, segs) {
  let m
  SEG_OPEN_RE.lastIndex = 0
  while ((m = SEG_OPEN_RE.exec(text))) {
    const tag = m[1].toLowerCase()
    const start = m.index + m[0].length
    const end = closeIndex(text, start, tag)
    if (end < 0) {
      // 注意：exec 落空会把 lastIndex 归零，所以探路用另一枚正则
      const ahead = new RegExp(SEG_OPEN_RE.source, 'gi')
      ahead.lastIndex = start
      const nxt = ahead.exec(text)
      push(stripTags(text.slice(start, nxt ? nxt.index : text.length)), segs)
      if (!nxt) break
      SEG_OPEN_RE.lastIndex = nxt.index
      continue
    }
    push(stripTags(text.slice(start, end)), segs)
    SEG_OPEN_RE.lastIndex = end + tag.length + 3
  }
  return segs
}

/** 空段丢掉，相邻重复段只留一次（分享按钮里常把标题重复一遍） */
function push(seg, segs) {
  if (!seg) return
  if (seg === segs[segs.length - 1]) return
  segs.push(seg)
}

/**
 * HTML → 纯文本（段落之间两个换行）。
 * 抽出来比 FULLTEXT_MIN_CHARS 短就返回空串：'' 表示「没抽到比摘要更多的东西」，
 * 调用方据此不覆盖已有内容——这是这个模块唯一对外承诺的语义。
 */
export function extractFulltext(html, url = '') {
  let text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of DROP_TAGS) text = dropBlocks(text, tag)
  text = dropNoise(pickContainer(text))
  const segs = collectSegments(text, [])
  const out = segs.join('\n\n')
  return out.length >= FULLTEXT_MIN_CHARS ? out : ''
}

/**
 * 抓 url 再抽正文。失败全部上抛，交给 pool 的 classifyError：
 * HTTP 非 2xx → e.status；不是 HTML → e.parse；抽不到东西 → e.empty；
 * 超时 → name='TimeoutError'。三种失败都只该让这条退回摘要，不该让一轮抓取停摆。
 */
export async function fetchFulltext(url, { signal, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const e = new Error(`正文抓取超过 ${timeoutMs}ms 无响应`)
      e.name = 'TimeoutError'
      reject(e)
    }, timeoutMs)
  })

  const work = (async () => {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'baleen/0.1.0 (+local; fulltext)',
        Accept: 'text/html,application/xhtml+xml'
      }
    })
    if (!res?.ok) {
      const e = new Error(`HTTP ${res?.status ?? '?'}`)
      e.status = res?.status ?? 0
      throw e
    }
    const ctype = String(res.headers?.get?.('content-type') ?? '')
    // xhtml 也是 HTML：Accept 里带了它，回过来就不该被当成"不是网页"
    if (!/text\/html|application\/xhtml\+xml/i.test(ctype)) {
      const e = new Error(`不是 HTML（content-type=${ctype || '缺失'}）`)
      e.parse = true
      throw e
    }
    const body = await res.text()
    const text = extractFulltext(body, url)
    if (!text) {
      const e = new Error('页面里抽不出比摘要更多的正文')
      e.empty = true
      throw e
    }
    return { text, chars: text.length }
  })()
  // 超时先赢时 work 的迟到拒绝会变成 unhandledRejection，先挂个空 catch 兜住
  work.catch(() => {})

  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
