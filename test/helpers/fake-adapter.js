/**
 * 契约测试替身：假适配器。runner 的全部测试都走它，不碰网络。
 * behaviors 按 source.id 配：给 items 就成功，给 error 就失败。
 */
export function fakeAdapter(name, behaviors) {
  const seen = []
  return {
    type: name,
    seen,
    async fetch(source, { since }) {
      seen.push({ id: source.id, since })
      const b = behaviors[source.id] ?? { error: Object.assign(new Error('未配置的源'), { status: 500 }) }
      if (b.error) throw b.error
      return b.items ?? []
    }
  }
}

const LONG = '<p>' + '内容'.repeat(220) + '</p>'

/** RawItem 的形状要和 rss 适配器的产出一致：url 由 external_id 派生，别几条共用一个 url */
export function rawOf(sourceId, over = {}) {
  const id = over.external_id ?? `${sourceId}-x`
  return {
    source_id: sourceId,
    source_type: 'rss',
    feed_title: 'F',
    external_id: id,
    url: `https://e.com/${id}`,
    title: 'DSH MCP 教程',
    author: '桉',
    author_id: null,
    published_at: 1500,
    body_html: LONG,
    summary_html: '短',
    thumb: null,
    duration_sec: null,
    tags: [],
    fetched_at: 2000,
    ...over
  }
}

export const timeoutError = () => Object.assign(new Error('超过 20000ms 无响应'), { name: 'TimeoutError' })
