import test from 'node:test'
import assert from 'node:assert/strict'
import { extractFulltext, fetchFulltext, FULLTEXT_MIN_CHARS } from '../lib/fulltext.js'

// 真实形态的博客页：article 里有正文，正文之外有评论区、相关推荐、脚本与导航。
// 这类页面的坑是"抽得出来"不够，得"抽出来的只有正文"——评论区混进来就等于伪造了内容。
const BLOG = `<!doctype html>
<html><head><title>DSH 插件怎么接 MCP</title><style>.x{color:red}</style></head>
<body>
  <header class="site-header"><nav><a href="/">首页</a><a href="/about">关于</a></nav></header>
  <main>
    <article>
      <h2>为什么要在本地做预筛</h2>
      <p>把判断交给模型之前先过一道不花钱的闸，量就压下来了。这一步不需要任何外部服务，规则全部可解释，也不产生任何费用，所以它可以在每一轮里都跑一遍，而不会让人心疼预算；反过来，如果连预筛都要调模型，那这条通道在低频作者身上根本跑不起来。</p>
      <p>同样的道理，抓正文也该在本地做：页面能抓到，就说明内容本来就在手上。把整页 HTML 丢给模型去读，既慢又贵，还会把导航和页脚里的字也算进判断理由里，理由行因此变得不可信；而理由行一旦不可信，三档判断就退化成了掷骰子。</p>
      <h3>三个前提</h3>
      <ul>
        <li>零依赖：不为了抽正文引一个几万行的库，规则要能在一屏里读完，出了问题自己就能改，也不必跟着上游的版本走。</li>
        <li>宁可抽不到，也不要抽错：抽出来太短就退回摘要，评论区被当成正文比只读摘要更糟，因为它会让人以为已经读到了全文。</li>
        <li>失败不覆盖已有内容：抽不到时保留原来的摘要，面板上那条记录的覆盖范围才是诚实的，用户点开才知道自己看到的是什么。</li>
      </ul>
      <p>最后这条是产品口径：用户看到的每一条内容，都得能说清它从哪来、读到了多少、为什么被判成这个档位，而不是只看到一个分数和一个结论；覆盖面是给人做取舍用的，含糊的覆盖面等于没有。</p>
      <div class="comments">
        <p>评论区第一层的话，绝不该进正文，哪怕它看起来像一段完整的论述也一样，因为它是别人写的，不是这篇文章说的。</p>
        <div class="comments-thread"><p>嵌套的回复同样不该进正文，这里特意放一层嵌套来试深度配对，非贪婪的正则会在这里切错。</p></div>
      </div>
      <div id="related-posts">
        <p>相关推荐里的另一篇文章标题，也不该进正文，它只是同一页上的另一个链接，抽进来就等于把别人的标题当成这篇的段落。</p>
      </div>
    </article>
  </main>
  <aside class="sidebar"><p>侧栏里的热门标签，不该进正文。</p></aside>
  <footer><p>页脚版权，不该进正文。</p></footer>
  <script>console.log('脚本里的字符串不该进正文')</script>
</body></html>`

test('真实形态博客页：只留 article 里的正文段落，评论区/相关推荐/脚本/页脚全丢掉', () => {
  const t = extractFulltext(BLOG, 'https://e.com/post/1')
  assert.ok(t.length >= FULLTEXT_MIN_CHARS, `抽出来太短：${t.length}`)
  // 正文都在
  assert.match(t, /把判断交给模型之前先过一道不花钱的闸/)
  assert.match(t, /零依赖：不为了抽正文引一个几万行的库/)
  assert.match(t, /用户看到的每一条内容，都得能说清它从哪来/)
  // 噪音一个都不许漏进来
  assert.equal(t.includes('评论区第一层'), false, '评论区混进正文')
  assert.equal(t.includes('嵌套的回复'), false, '嵌套评论混进正文')
  assert.equal(t.includes('相关推荐'), false, '相关推荐混进正文')
  assert.equal(t.includes('侧栏里的热门标签'), false, 'aside 混进正文')
  assert.equal(t.includes('页脚版权'), false, 'footer 混进正文')
  assert.equal(t.includes('脚本里的字符串'), false, 'script 混进正文')
  assert.equal(t.includes('首页'), false, 'nav 混进正文')
  // 段落之间是两个换行，且没有残留标签
  assert.equal(t.includes('<'), false, '还有标签没剥')
  assert.match(t, /\n\n/)
  assert.equal(t.split('\n\n').length >= 5, true, '段落没被切开')
})

test('只有 <p> 的朴素页面也能抽，且相邻重复段只留一次', () => {
  // 朴素页面：没有 article、没有 main，只有 body 里一串 p——很多自建博客就是这个形态。
  // 段落用「首句 + 重复的补充句」拼出来，长度稳定在门槛之上，断言看的仍是段落对不对。
  const pad = '后面这几句是同一段的补充说明，用来把长度撑过门槛，段落本身还是同一段。'
  const a = '第一段：插件在本地跑，不上传任何东西，抓到的内容只落本机的 sqlite。判断那一轮也只给只读工具。' + pad.repeat(3)
  const b = '第二段：抓不到的页面就退回摘要，不覆盖已有内容，也不假装抓到了。面板上写的是摘要就是摘要。' + pad.repeat(3)
  const c = '第三段：所有的判断理由都要能落到具体的关键词上，不能只给一个分数。人看不懂理由就等于没有理由。' + pad.repeat(3)
  const d = '第四段：这一条是给面板用的，告诉用户读到了多少、为什么被判成这个档位。点开记录要能对上依据。' + pad.repeat(3)
  const plain = `<html><body>
    <p>${a}</p>
    <p>${a}</p>
    <p>${b}</p>
    <p>${c}</p>
    <p>${d}</p>
  </body></html>`
  const t = extractFulltext(plain)
  assert.ok(t.length >= FULLTEXT_MIN_CHARS, `朴素页面抽出来太短：${t.length}`)
  assert.equal(t.split('\n\n').length, 4, '相邻重复段没有去重')
  assert.match(t, /第四段/)
  assert.equal(t.includes('<p>'), false)
})

test('不足 400 字返回空串——空串的语义是"没抽到比摘要更多的东西"', () => {
  assert.equal(extractFulltext('<article><p>太短的一段话。</p></article>'), '')
  assert.equal(extractFulltext('<html><body><p>只有一句话</p></body></html>'), '')
  assert.equal(extractFulltext(''), '')
  assert.equal(extractFulltext(null), '')
  // 只有噪音、没有正文时同样必须是空串，不能拿评论区凑数
  const noiseOnly = '<article><div class="comments">' + '<p>评论'.repeat(300) + '</p></div></article>'
  assert.equal(extractFulltext(noiseOnly), '')
  // 边界：恰好等于门槛要收（>= 而不是 >）
  const exact = 'x'.repeat(FULLTEXT_MIN_CHARS)
  assert.equal(extractFulltext(`<article><p>${exact}</p></article>`).length, FULLTEXT_MIN_CHARS)
})

const okBody = '<article><p>' + '正文段落要够长。'.repeat(60) + '</p></article>'

test('fetchFulltext：成功返回 { text, chars }，请求头带上 baleen 的 UA', async () => {
  let seen = null
  const r = await fetchFulltext('https://e.com/post', {
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers }
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
        text: async () => okBody
      }
    }
  })
  assert.equal(r.chars, r.text.length)
  assert.ok(r.chars >= FULLTEXT_MIN_CHARS)
  assert.match(r.text, /正文段落要够长/)
  assert.equal(seen.url, 'https://e.com/post')
  assert.equal(seen.headers['User-Agent'], 'baleen/0.1.0 (+local; fulltext)')
  assert.equal(seen.headers.Accept, 'text/html,application/xhtml+xml')
})

test('fetchFulltext：HTTP 500 抛带 status 的错（pool 会分类成 http）', async () => {
  await assert.rejects(
    fetchFulltext('https://e.com/500', {
      fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => 'text/html' }, text: async () => '' })
    }),
    (e) => e.status === 500
  )
})

test('fetchFulltext：content-type 不是 HTML 抛 parse', async () => {
  await assert.rejects(
    fetchFulltext('https://e.com/data.json', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain' : null) },
        text: async () => 'plain text'
      })
    }),
    (e) => e.parse === true
  )
})

test('fetchFulltext：页面里抽不出正文抛 empty', async () => {
  await assert.rejects(
    fetchFulltext('https://e.com/thin', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
        text: async () => '<html><body><p>太短</p></body></html>'
      })
    }),
    (e) => e.empty === true
  )
})

test('fetchFulltext：超时抛 name=TimeoutError，并 abort 掉在飞的请求', async () => {
  let aborted = false
  await assert.rejects(
    fetchFulltext('https://e.com/slow', {
      timeoutMs: 20,
      // 永不 resolve 的桩：真实场景就是连接挂住，signal 必须被 abort
      fetchImpl: (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      })
    }),
    (e) => e.name === 'TimeoutError'
  )
  assert.equal(aborted, true, '超时没有 abort 在飞的请求')
})
