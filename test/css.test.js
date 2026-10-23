import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CSS, injectStyles } from '../src/client/css.js'
import { loadClient, exportsOf } from '../tools/client-loader.mjs'

/**
 * token 清单来自本机已跑通的 dsh-study-desk（DSH 0.2.1-rc.2）。
 * 写不在清单里的名字不算"更有创意"，而是宿主里取不到值、整块裸奔。
 */
const HOST_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-dimmed',
  '--dsw-alias-brand-primary', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary'
])

const viewSources = () => {
  const root = path.join(process.cwd(), 'src', 'client')
  const out = []
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js') && e.name !== 'css.js' || e.name.endsWith('.txt')) out.push(fs.readFileSync(p, 'utf8'))
  })
  walk(root)
  return out.join('\n')
}

test('CSS 里一个颜色字面量都没有（十六进制、函数式、颜色名都不许）', () => {
  const offenders = []
  for (const re of [/#[0-9a-fA-F]{3,8}\b/g, /\b(?:rgba?|hsla?|color)\(/g, /:\s*(?:white|black|red|green|blue|gray|grey|silver|orange|purple)\b/g]) {
    let m
    while ((m = re.exec(CSS))) offenders.push(m[0])
  }
  assert.deepEqual(offenders, [], '硬编码颜色：' + offenders.join(', '))
})

test('用到的 token 都在宿主实测清单里，且真的用到了一小把', () => {
  const used = [...CSS.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1])
  assert.ok(used.length > 20, '只用了 ' + used.length + ' 个 token，大概是想自己画')
  const bogus = [...new Set(used.filter((t) => !HOST_TOKENS.has(t)))]
  assert.deepEqual(bogus, [], '宿主里没有这些 token：' + bogus.join(', '))
  for (const t of new Set(used)) assert.ok(new RegExp(`var\\(${t}\\)`).test(CSS))
})

test('var() 一律不带内联兜底：兜底色会把硬编码颜色请回来', () => {
  assert.doesNotMatch(CSS, /var\(--dsw-[a-z0-9-]+\s*,/, '出现带兜底的 var()')
  assert.doesNotMatch(CSS, /light-dark\(/)
})

test('网格用 auto-fill minmax(260px,1fr)，容器不许自己限宽', () => {
  assert.match(CSS, /grid-template-columns:\s*repeat\(\s*auto-fill\s*,\s*minmax\(\s*260px\s*,\s*1fr\s*\)\s*\)/)
  assert.match(CSS, /\.bl-root\s*\{[^}]*width:\s*100%/)
  const noMedia = CSS.replace(/@media[^{]*\{/g, '@media{')
  assert.doesNotMatch(noMedia, /\.bl-(?:root|body|grid|two|library)[^}]*max-width/, '容器限宽=两侧大空白')
})

test('字号只有 13/12/11，字重只有 400/500', () => {
  const sizes = [...CSS.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 10)
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [11, 12, 13])
  const weights = [...CSS.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => m[1])
  assert.deepEqual([...new Set(weights)].sort(), ['400', '500'])
})

test('可点目标不低于 32px，焦点可见，且尊重 reduced-motion', () => {
  assert.match(CSS, /\.bl-navitem\{[^}]*min-height:32px/)
  assert.match(CSS, /\.bl-dbtns button\{[^}]*min-height:32px/)
  assert.match(CSS, /\.bl-facets label\{[^}]*min-height:32px/)
  assert.match(CSS, /:focus-visible\{outline:2px solid var\(--dsw-alias-brand-primary\)/)
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)/)
})

test('视图里出现的每个 bl- 类名都有对应样式：漏一个就是没样式的裸节点', () => {
  const names = new Set()
  // 扫所有含 bl- 的字符串字面量，而不是只看 className: 'x' —— 三元里的 className: ok ? '' : 'bl-missing'
  // 用前者会整类漏掉，而那种"条件才加的类"恰恰是最容易忘配样式的
  for (const m of viewSources().matchAll(/'([^']*bl-[a-z0-9-][^']*)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('bl-')) names.add(c)
  }
  assert.ok(names.size > 40, '只扫到 ' + names.size + ' 个类名，正则大概失配了')
  const missing = [...names].filter((c) => !CSS.includes('.' + c))
  assert.deepEqual(missing, [], '这些类名没有样式：' + missing.join(', '))
})

test('样式表只注入一次，且注入到 head', () => {
  injectStyles()
  const s = loadClient()
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  const styled = s.created.filter((el) => 'data-baleen' in el.attrs)
  assert.equal(styled.length, 1, '重复注入会让样式表堆叠')
  assert.ok(styled[0].textContent.length > 2000)
})
