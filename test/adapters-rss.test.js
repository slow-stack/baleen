import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rssAdapter, adapterFor, ADAPTERS } from '../lib/adapters/index.js'

const fx = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f), 'utf8')
const source = { id: 'blog-a', type: 'rss', url: 'https://example.substack.com/feed', label: 'Naval Notes' }

test('正常抓取：产出 RawItem，fetched_at 由适配器盖章，feed_title 带上', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'], accept: init.headers.Accept })
    return { ok: true, status: 200, text: async () => fx('substack.xml') }
  }
  const items = await rssAdapter.fetch(source, { since: null, fetchImpl, now: () => 1730000000000 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, source.url)
  assert.match(calls[0].ua, /^baleen\//)
  assert.match(calls[0].accept, /rss|atom|xml/)
  assert.equal(items.length, 2)
  assert.equal(items[0].source_id, 'blog-a')
  assert.equal(items[0].source_type, 'rss')
  assert.equal(items[0].feed_title, 'Naval Notes')
  assert.equal(items[0].fetched_at, 1730000000000)
  assert.equal(items[0].external_id, 'rss-33771')
})

test('非 2xx 抛带 status 的错（会被分类成 http）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' })
  await assert.rejects(() => rssAdapter.fetch(source, { since: null, fetchImpl }), e => e.status === 403)
})

test('fetch 本身抛（DNS 断）原样上抛，由 pool 分类', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(() => rssAdapter.fetch(source, { since: null, fetchImpl }), TypeError)
})

test('解析出 0 条抛 empty——它不算成功，所以游标不会推进', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html><body>no feed</body></html>' })
  await assert.rejects(() => rssAdapter.fetch(source, { since: null, fetchImpl }), e => e.empty === true)
})

test('since 只过滤"明确更旧"的条目；没有时间的条目留着交给去重', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => fx('substack.xml') })
  const since = new Date('2026-10-21T12:00:00Z').getTime()
  const items = await rssAdapter.fetch(source, { since, fetchImpl })
  assert.equal(items.length, 1)
  assert.equal(items[0].external_id, 'https://example.substack.com/p/summary-only')
})

test('adapterFor 只认注册过的类型，大小写不敏感', () => {
  assert.equal(adapterFor('rss'), ADAPTERS.rss)
  assert.equal(adapterFor('RSS'), ADAPTERS.rss)
  assert.equal(adapterFor('bili'), ADAPTERS.bili)
  assert.equal(adapterFor('xhs'), null)
  assert.equal(adapterFor(undefined), null)
})
