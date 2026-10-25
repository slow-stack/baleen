import { rssAdapter } from './rss.js'
import { biliAdapter } from './bili.js'
import { ytAdapter } from './yt.js'

/**
 * 适配器注册表。M1 只有 rss；bili（M4a）与 yt（M4b）已登记，xhs 由后续计划进，
 * runner 不需要认识任何具体平台——它只按 source.type 查这张表。
 */
export const ADAPTERS = { rss: rssAdapter, bili: biliAdapter, yt: ytAdapter }
export { rssAdapter, biliAdapter, ytAdapter }

export function adapterFor(type) {
  const key = String(type ?? '').toLowerCase()
  return ADAPTERS[key] ?? null
}
