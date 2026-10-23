import { rssAdapter } from './rss.js'

/**
 * 适配器注册表。M1 只有 rss；bili / xhs / yt 由 M4 登记进来，
 * runner 不需要认识任何具体平台——它只按 source.type 查这张表。
 */
export const ADAPTERS = { rss: rssAdapter }
export { rssAdapter }

export function adapterFor(type) {
  const key = String(type ?? '').toLowerCase()
  return ADAPTERS[key] ?? null
}
