import { parseFeed } from '../feed.js'

const VERSION = '0.1.0'
export const type = 'rss'

/**
 * 只负责把 feed 翻译成 RawItem：不判断、不写库、不重试（重试由 pool 统一管）。
 * 三种失败都上抛，交给 pool 分类：HTTP 非 2xx（带 status）、网络异常、feed 里没有条目（带 empty）。
 * "0 条目"必须当成失败：如果它算成功，游标就会被推进，这段区间的真实内容就永久没了。
 */
export async function fetchRss(source, { since = null, signal, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!source?.url) {
    const e = new Error('rss 源缺少 url')
    e.parse = true
    throw e
  }
  const res = await fetchImpl(source.url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': `baleen/${VERSION} (+local; rss reader)`,
      Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'
    }
  })
  if (!res?.ok) {
    const e = new Error(`HTTP ${res?.status ?? '?'}`)
    e.status = res?.status ?? 0
    throw e
  }
  const xml = await res.text()
  const parsed = parseFeed(xml)
  if (!parsed.items.length) {
    const e = new Error(`feed 里没有条目（format=${parsed.format}）`)
    e.empty = true
    throw e
  }
  const stamped = now()
  return parsed.items
    .filter(i => !(i.published_at != null && since != null && i.published_at <= since))
    .map(i => ({
      source_id: source.id,
      source_type: type,
      feed_title: parsed.feed_title,
      external_id: i.external_id,
      url: i.url,
      title: i.title,
      author: i.author,
      published_at: i.published_at,
      body_html: i.body_html,
      summary_html: i.summary_html,
      thumb: i.thumb,
      duration_sec: i.duration_sec,
      tags: i.tags,
      fetched_at: stamped
    }))
}

export const rssAdapter = { type, fetch: fetchRss }
