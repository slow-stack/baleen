import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFeed, stripTags, decode, cleanUrl, parseDuration } from '../lib/feed.js'

const fx = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f), 'utf8')

test('RSS2：CDATA 标题、全文与摘要分开拿到、guid 作 id', () => {
  const { format, feed_title, items } = parseFeed(fx('substack.xml'))
  assert.equal(format, 'rss')
  assert.equal(feed_title, 'Naval Notes')
  assert.equal(items.length, 2)
  const a = items[0]
  assert.equal(a.title, '为什么 RSS 还活着：12 个新闻站的取样')
  assert.equal(a.external_id, 'rss-33771')
  assert.equal(a.author, 'A. Lefèvre')
  assert.equal(a.url, 'https://example.substack.com/p/rss-2026')   // utm 已清掉
  assert.ok(a.body_html.includes('第二段有数字'))
  assert.ok(a.summary_html.includes('9 个提供完整正文'))
  assert.notEqual(a.body_html, a.summary_html)
  assert.equal(a.duration_sec, null)
  assert.deepEqual(a.tags, ['工具', '资讯'])
  assert.equal(typeof a.published_at, 'number')
})

test('RSS2：坏日期不炸，字段落 null；无 guid 时 id 退到 link', () => {
  const { items } = parseFeed(fx('substack.xml'))
  const b = items[1]
  assert.equal(b.published_at, null)
  assert.equal(b.body_html, null)                        // description 只算摘要，不当全文
  assert.equal(b.summary_html, '摘要而已。')
  assert.equal(b.external_id, 'https://example.substack.com/p/summary-only')
})

test('Atom：link rel=alternate、author/name、media 缩略图、转义正文', () => {
  const { format, items } = parseFeed(fx('atom.xml'))
  assert.equal(format, 'atom')
  assert.equal(items.length, 2)
  assert.equal(items[0].url, 'https://blog.example.org/p/118')
  assert.equal(items[0].thumb, 'https://blog.example.org/i/118.jpg')
  assert.equal(items[0].author, '桉')
  assert.equal(items[0].external_id, 'tag:blog.example.org,2026:/p/118')
  assert.ok(stripTags(items[0].body_html).includes('burned_in'))
  assert.equal(items[1].title, '<震惊> & 转义测试')
  assert.equal(items[1].body_html, null)
  assert.equal(items[1].summary_html, '只有 summary')
})

test('时长三种写法都换算：18:22、1:02:03、纯秒数', () => {
  assert.equal(parseDuration('18:22'), 1102)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration('300'), 300)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration('abc'), null)
  assert.equal(parseDuration(null), null)
})

test('cleanUrl 去掉跟踪参数与 fragment，保留有意义的 query', () => {
  assert.equal(cleanUrl('https://e.com/a?utm_source=q&ref=1#frag'), 'https://e.com/a')
  assert.equal(cleanUrl('https://e.com/a/?fbclid=x'), 'https://e.com/a')
  assert.equal(cleanUrl('https://e.com/a?page=2'), 'https://e.com/a?page=2')
  assert.equal(cleanUrl(null), null)
})

test('垃圾输入返回空条目而不是抛异常', () => {
  for (const junk of ['', 'not xml at all', '<rss><channel></channel></rss>', '<?xml version="1.0"?><html><body>hi</body></html>', null]) {
    const r = parseFeed(junk ?? '')
    assert.ok(Array.isArray(r.items))
    assert.equal(r.items.length, 0)
  }
})

test('嵌套标签不被误当条目边界（同名标签出现在正文里）', () => {
  const xml = `<rss><channel><title>c</title>
    <item><title>一条</title><link>https://e.com/1</link><guid>g1</guid><description>普通</description></item>
    <item><title>两条</title><link>https://e.com/2</link><guid>g2</guid></item>
  </channel></rss>`
  const { items } = parseFeed(xml)
  assert.deepEqual(items.map(i => i.external_id), ['g1', 'g2'])
  assert.equal(items[1].summary_html, null)
})

test('decode 处理命名与数字实体，非法实体原样留着', () => {
  assert.equal(decode('a&amp;b'), 'a&b')
  assert.equal(decode('&#95;'), '_')
  assert.equal(decode('&#x4f60;&#x597d;'), '你好')
  assert.equal(decode('&notanentity;'), '&notanentity;')
})
