/**
 * 面板取数层。三条规矩：
 *  1. 失败绝不抛到渲染层——回 `{ ok:false, stale:true, data:上次快照 }`，顶栏据此出灰条；
 *  2. 快照只存"能渲染的状态"，不存正文（真相在 sqlite 里，快照是为了宿主没起来时不白屏）；
 *  3. feedback 的动作是白名单，不接收调用方传来的 delta——
 *     否则一个坏掉的（或被改过的）前端就能把来源权重推到任意值。
 */
const API_BASE = '/api/dsh-baleen'

export const SNAPSHOT_KEY = 'baleen.snapshot'

export function createApi({ fetch: fetchImpl = globalThis.fetch, storage = globalThis.localStorage, actions = { dismiss: -0.1, save: 0.1 } } = {}) {
  function write(obj) {
    try { storage.setItem(SNAPSHOT_KEY, JSON.stringify(obj)) } catch { /* 隐私模式或配额满，记不上就算了 */ }
  }
  function readCached() {
    try {
      const t = storage.getItem(SNAPSHOT_KEY)
      const p = t ? JSON.parse(t) : null
      return p && typeof p === 'object' && !Array.isArray(p) ? p : null
    } catch { return null }
  }
  async function call(url, init) {
    try {
      const res = await fetchImpl(url, init)
      if (!res || res.ok === false) throw new Error('HTTP ' + ((res && res.status) ?? '?'))
      return { json: await res.json(), httpOk: true }
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }
  async function get(url) {
    const r = await call(url, { cache: 'no-store' })
    if (r.httpOk) { write(r.json); return { ok: true, stale: false, data: r.json } }
    return { ok: false, stale: true, data: readCached(), error: r.error }
  }

  return {
    snapshot: readCached,
    state: () => get(API_BASE + '/state'),
    items: (q = {}) => get(API_BASE + '/items?' + new URLSearchParams(q).toString()),
    async run() {
      const r = await call(API_BASE + '/run', { method: 'POST' })
      if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
      const next = r.json && r.json.state ? r.json.state : r.json
      if (next) write(next)
      return { ok: true, stale: false, data: r.json }
    },
    async feedback(sourceId, action) {
      if (!Object.prototype.hasOwnProperty.call(actions, action)) throw new Error('未知动作：' + action)
      if (!sourceId) throw new Error('feedback 需要 source_id')
      const r = await call(API_BASE + '/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, action })
      })
      if (!r.httpOk) return { ok: false, stale: true, data: readCached(), error: r.error }
      return { ok: true, stale: false, data: r.json }
    }
  }
}
