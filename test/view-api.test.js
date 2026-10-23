import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi, SNAPSHOT_KEY } from '../src/client/view-api.js'

const memStorage = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

const okFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload })

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
