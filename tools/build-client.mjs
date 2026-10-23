/**
 * 从 src/client/*.js 生成 loader 格式的 client.js。
 *
 * 没有打包器：DSH 的客户端 ModuleLoader 直接吃单文件，静态模块只有 react / react-dom。
 * 所以这里只做"按序内联 + 包进 load({id, factory})"，不做转译、不改语义。
 *
 * 为什么不让 client.js 继续手写：纯逻辑（reducer、取数层、渲染器）一旦散进那一个大文件，
 * 就没法在 Node 里单独测，只能靠"整页在浏览器里看起来对"来验收。拆源文件 + 生成，
 * 换来的是可测，代价是一条"改了源忘了生成"的守卫测试（test/build.test.js）。
 *
 * 用法：
 *   node tools/build-client.mjs          写 client.js
 *   node tools/build-client.mjs --check  不写；磁盘上的 client.js 与生成结果不一致则退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'client.js')

/** 顺序有意义：状态与取数在前，视图在后，装配（_footer）最后。加视图往这里追加。 */
export const PARTS = ['view-state.js', 'view-api.js', 'vnode.js', 'match.js', 'css.js',
  'views/today.js', 'views/video.js', 'views/article.js', 'views/digest.js', 'views/library.js', 'views/drawer.js']

const HEADER = fs.readFileSync(path.join(ROOT, 'src', 'client', '_header.txt'), 'utf8')
const FOOTER = fs.readFileSync(path.join(ROOT, 'src', 'client', '_footer.txt'), 'utf8')

const stripModuleSyntax = (src) => src
  .replace(/^import\s[^\n]*\n/gm, '')
  .replace(/^export\s+(const|function|class|async function)\s/gm, '$1 ')
  .replace(/^export\s*\{[^}]*\}\s*;?\s*\n/gm, '')
  .replace(/^export default\s+/gm, 'const __default = ')
  .trim()

/** loader bundle 里的代码都在 factory 内层，生成时统一缩进 4 空格 */
const indent = (src) => src.split('\n').map((l) => (l.trim() ? `    ${l}` : '')).join('\n')

export function build() {
  const body = PARTS.map((p) => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'client', p), 'utf8')
    return indent(`// ---- src/client/${p} ----\n${stripModuleSyntax(src)}\n`)
  }).join('\n')
  if (!HEADER.includes('/*__BODY__*/')) throw new Error('_header.txt 里少了 /*__BODY__*/ 占位')
  return HEADER.replace('/*__BODY__*/', body) + FOOTER
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/build-client.mjs')

if (isMain) {
  const out = build()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (cur !== out) {
      console.error('client.js 已过期：跑 node tools/build-client.mjs')
      process.exit(1)
    }
    console.log('client.js 是最新的')
    process.exit(0)
  }
  fs.writeFileSync(OUT, out, 'utf8')
  console.log(`client.js 已生成（${PARTS.length} 个源文件）`)
}
