import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi, SNAPSHOT_KEY } from '../src/client/view-api.js'

const memStorage = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

const okFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload })

const recorder = (responses = {}) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const key = String(url).replace('/api/dsh-baleen', '')
    const r = responses[key.split('?')[0]] ?? { code: 200, json: { ok: true } }
    return { ok: r.code < 400, status: r.code, json: async () => r.json }
  }
  return { calls, fetchImpl }
}

test('成功时把快照写进 storage，并标 stale=false', async () => {
  const st = memStorage()
  const api = createApi({ fetch: okFetch({ ok: true, counts: { new: 3 } }), storage: st })
  const r = await api.state()
  assert.equal(r.ok, true)
  assert.equal(r.stale, false)
  assert.deepEqual(r.data.counts, { new: 3 })
  assert.match(st.getItem(SNAPSHOT_KEY), /"new":3/)
})

test('失败时回落到上次快照并标 stale=true，不抛不白屏', async () => {
  const st = memStorage()
  await createApi({ fetch: okFetch({ ok: true, counts: { new: 7 } }), storage: st }).state()
  const api2 = createApi({ fetch: async () => { throw new TypeError('fetch failed') }, storage: st })
  const r = await api2.state()
  assert.equal(r.ok, false)
  assert.equal(r.stale, true)
  assert.deepEqual(r.data.counts, { new: 7 })
  assert.match(r.error, /fetch failed/)
})

test('HTTP 非 2xx 也算失败，走同一回落', async () => {
  const st = memStorage()
  await createApi({ fetch: okFetch({ counts: { new: 1 } }), storage: st }).state()
  const api = createApi({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), storage: st })
  const r = await api.state()
  assert.equal(r.ok, false)
  assert.match(r.error, /HTTP 500/)
  assert.deepEqual(r.data.counts, { new: 1 })
})

test('没有快照也没关系：data 为 null，渲染层负责空态', async () => {
  const api = createApi({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), storage: memStorage() })
  const r = await api.state()
  assert.equal(r.ok, false)
  assert.equal(r.data, null)
})

test('坏快照被丢掉而不是让后续渲染崩', async () => {
  const st = memStorage()
  st.setItem(SNAPSHOT_KEY, '{坏掉的')
  const api = createApi({ fetch: async () => { throw new Error('fetch failed') }, storage: st })
  const r = await api.state()
  assert.equal(r.data, null)
})

test('items 把查询参数拼进去并原样取回', async () => {
  const seen = []
  const api = createApi({
    fetch: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) } },
    storage: memStorage()
  })
  await api.items({ status: 'new', limit: 50 })
  assert.equal(seen[0], '/api/dsh-baleen/items?status=new&limit=50')
})

test('feedback 只允许白名单动作，且不带 delta', async () => {
  const calls = []
  const api = createApi({
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, tuning: { 'blog-a': -0.1 } }) } },
    storage: memStorage()
  })
  const r = await api.feedback('blog-a', 'dismiss')
  assert.equal(calls[0].url, '/api/dsh-baleen/feedback')
  assert.deepEqual(calls[0].body, { source_id: 'blog-a', action: 'dismiss' })
  assert.deepEqual(r.data.tuning, { 'blog-a': -0.1 })
  await assert.rejects(() => api.feedback('blog-a', 'like'), /未知动作/)
  await assert.rejects(() => api.feedback('', 'save'), /需要 source_id/)
})

test('run() 走 POST，并把回传的 state 当作新快照', async () => {
  const st = memStorage()
  const api = createApi({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, status: 'done', state: { counts: { new: 2 } } }) }),
    storage: st
  })
  const r = await api.run()
  assert.equal(r.ok, true)
  assert.deepEqual(JSON.parse(st.getItem(SNAPSHOT_KEY)).counts, { new: 2 })
})

test('storage 炸了也不影响取数（隐私模式或配额满）', async () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
  const api = createApi({ fetch: okFetch({ counts: { new: 9 } }), storage: boom })
  const r = await api.state()
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.counts, { new: 9 })
})

test('collect 发的是 item_id + folder_ids，没给 new_folder 时这个键根本不出现在载荷里', async () => {
  const { calls, fetchImpl } = recorder({ '/collect': { code: 200, json: { ok: true, folder_ids: [2] } } })
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  const out = await api.collect(7, [2])
  assert.equal(out.ok, true)
  assert.deepEqual(JSON.parse(calls[0].init.body), { item_id: 7, folder_ids: [2] })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
})

test('collect 带上 new_folder（非空字符串才带）', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  await api.collect(7, [], '新夹')
  assert.deepEqual(JSON.parse(calls[0].init.body), { item_id: 7, folder_ids: [], new_folder: '新夹' })
  await api.collect(7, [], '   ')
  assert.equal(JSON.parse(calls[1].init.body).new_folder, undefined, '全空白的夹名不该发出去')
})

test('folder_gone 的 410 要带着是哪几个夹回来——这是收藏唯一的"半途失败"路径', async () => {
  const { fetchImpl } = recorder({ '/collect': { code: 410, json: { ok: false, error: 'folder_gone', missing: [3, 5] } } })
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  const out = await api.collect(7, [3, 5])
  assert.equal(out.ok, false)
  assert.equal(out.error, 'folder_gone')
  assert.deepEqual(out.missing, [3, 5])
})

test('folderOp 三种动作都发对载荷', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  await api.folderOp('create', { name: '一' })
  await api.folderOp('rename', { id: 2, name: '二' })
  await api.folderOp('delete', { id: 2 })
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'create', name: '一' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'rename', id: 2, name: '二' })
  assert.deepEqual(JSON.parse(calls[2].init.body), { action: 'delete', id: 2 })
})

test('folders() 读得到，但不把共享快照盖掉（否则下一次 state 失败会拿到夹列表）', async () => {
  const storage = memStorage()
  const { fetchImpl } = recorder({ '/folders': { code: 200, json: { ok: true, folders: [{ id: 1, name: '默认', is_default: 1, count: 0 }] } } })
  const api = createApi({ fetch: fetchImpl, storage })
  const out = await api.folders()
  assert.deepEqual(out.data.folders[0].name, '默认')
  assert.equal(storage.getItem(SNAPSHOT_KEY), null, 'folders 写进了共享快照')
})

test('路由整个缺席时 folders() 报 stale 且 data 为 null，由渲染层出"读不到夹"', async () => {
  const api = createApi({ fetch: async () => { throw new Error('fetch failed') }, storage: memStorage() })
  const out = await api.folders()
  assert.equal(out.ok, false)
  assert.equal(out.stale, true)
  assert.equal(out.data, null)
})
