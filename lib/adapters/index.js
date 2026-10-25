import { rssAdapter } from './rss.js'
import { biliAdapter } from './bili.js'

/**
 * 适配器注册表。M1 只有 rss；bili（M4a）已登记，xhs / yt 由 M4b 再进，
 * runner 不需要认识任何具体平台——它只按 source.type 查这张表。
 */
export const ADAPTERS = { rss: rssAdapter, bili: biliAdapter }
export { rssAdapter, biliAdapter }

export function adapterFor(type) {
  const key = String(type ?? '').toLowerCase()
  return ADAPTERS[key] ?? null
}
