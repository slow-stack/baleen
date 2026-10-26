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

  /**
   * 写请求专用。与 get() 的分别：4xx/5xx 也要把响应体读出来——
   * folder_gone 带的是"哪几个夹没了"，丢了就等于面板只能说"没记上"，
   * 而用户真正需要知道的是那个夹已经被删了，换个夹再收一次。
   */
  async function post(urlPath, payload) {
    return send('POST', urlPath, payload)
  }

  /** 设置页的 PUT（preference / credential）：与 post 同一套"错误体也要读回来"的规矩。 */
  async function put(urlPath, payload) {
    return send('PUT', urlPath, payload)
  }

  async function send(method, urlPath, payload) {
    try {
      const res = await fetchImpl(API_BASE + urlPath, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const status = (res && res.status) ?? 0
      let json = null
      try { json = res && await res.json() } catch { json = null }
      if (res && res.ok === false) {
        return {
          ok: false,
          error: (json && json.error) || ('HTTP ' + status),
          missing: (json && json.missing) || undefined,
          data: json
        }
      }
      return { ok: true, stale: false, data: json }
    } catch (e) {
      return { ok: false, stale: true, error: String((e && e.message) || e), data: null }
    }
  }

  /**
   * 设置页的只读 GET。绝不走 get()：那会把应答写进共享快照（baleen.snapshot），
   * 而 /state 的失败回落靠的是它——preference 的应答盖上去，面板顶栏就会
   * 拿偏好数据冒充面板状态。
   */
  async function plainGet(urlPath) {
    try {
      const res = await fetchImpl(API_BASE + urlPath, { cache: 'no-store' })
      if (!res || res.ok === false) return { ok: false, stale: true, data: null }
      return { ok: true, stale: false, data: await res.json() }
    } catch { return { ok: false, stale: true, data: null } }
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
    },
    folders: async () => {
      try {
        const res = await fetchImpl(API_BASE + '/folders', { cache: 'no-store' })
        if (!res || res.ok === false) return { ok: false, stale: true, data: null }
        return { ok: true, stale: false, data: await res.json() }
      } catch { return { ok: false, stale: true, data: null } }
    },
    collect: (itemId, folderIds, newFolder) => post('/collect', {
      item_id: itemId,
      folder_ids: Array.isArray(folderIds) ? folderIds : [],
      ...(typeof newFolder === 'string' && newFolder.trim() ? { new_folder: newFolder.trim() } : {})
    }),
    folderOp: (action, { id, name } = {}) => post('/folder', { action, ...(id != null ? { id } : {}), ...(name != null ? { name } : {}) }),
    /* 设置页（settings.section）的取数与动作：GET 走 plainGet（不碰共享快照），写走 post/put */
    preferenceGet: () => plainGet('/preference'),
    preferencePut: (section, value) => put('/preference', { section, value }),
    tuningReset: () => post('/tuning-reset', {}),
    credentialStatus: () => plainGet('/credential-status'),
    credentialPut: (which, content) => put('/credential', { which, content }),
    envCheck: () => plainGet('/env-check'),
    diagTail: (lines) => plainGet('/diagnostics-tail?lines=' + (Number.isInteger(lines) ? lines : 50)),
    exportMd: () => post('/export', {}),
    cleanup: (days) => post('/cleanup', { days }),
    wipe: (confirmText) => post('/wipe', { confirm: confirmText }),
  }
}
