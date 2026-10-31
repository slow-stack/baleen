import { rssAdapter } from './rss.js'
import { biliAdapter } from './bili.js'
import { ytAdapter } from './yt.js'
import { xhsAdapter } from './xhs.js'

/**
 * 适配器注册表。M1 只有 rss；bili（M4a）与 yt（M4b）已登记；xhs（M6）经官方 MCP
 * 接入——runner 不需要认识任何具体平台——它只按 source.type 查这张表。
 */
export const ADAPTERS = { rss: rssAdapter, bili: biliAdapter, yt: ytAdapter, xhs: xhsAdapter }
export { rssAdapter, biliAdapter, ytAdapter, xhsAdapter }

export function adapterFor(type) {
  const key = String(type ?? '').toLowerCase()
  return ADAPTERS[key] ?? null
}
