/**
 * 预览门：用**真视图函数**出静态 HTML，明暗两块。
 *
 * 这不是另画一套页面给人看——它调的就是 src/client/views/ 里那批渲染函数，
 * 所以预览对了，面板也就对了（唯一对不上的是真 React 的节点形状与宿主真实调色板，
 * 那两样只能在真机上看）。
 *
 * token 值是**替身**：按宿主观感近似，不是宿主真调色板。CSS 里一个颜色都没有，
 * 所以脱离宿主必须自己声明一批 --dsw-alias-*，预览才不至于白底黑字糊成一片。
 *
 * 用法：node tools/preview.mjs        → out/preview-*.html
 *      node tools/preview.mjs --shots → 另外用无头 Edge 出明暗截图（需要 PATH 上有 msedge）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSS } from '../src/client/css.js'
import { vnode } from '../src/client/vnode.js'
import { Nav, TopBar } from '../src/client/views/shell.js'
import { TodayView } from '../src/client/views/today.js'
import { VideoView } from '../src/client/views/video.js'
import { ArticleView } from '../src/client/views/article.js'
import { DigestView } from '../src/client/views/digest.js'
import { LibraryView } from '../src/client/views/library.js'
import { Drawer } from '../src/client/views/drawer.js'
import { previewState, previewItems } from '../test/fixtures/preview-data.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 空元素：写成 <input> 而不是 <input></input>，浏览器对后者会多塞一层。 */
const VOID = new Set(['input', 'img', 'br', 'hr', 'source', 'meta', 'link', 'col', 'area', 'base'])

/** React 的属性名 → HTML 的属性名。不转的话浏览器认不得 className，整页样式静默失效。 */
const ATTR_NAME = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', ariaLabel: 'aria-label' }

/** 把 {type,props,children} 吐成 HTML：桩、预览共用这一个形状，所以这里不需要 React。 */
export function toHtml(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props = {}, children = [] } = node
  const attr = Object.entries(props)
    .filter(([k, v]) => v !== undefined && v !== null && v !== false && typeof v !== 'function' && k !== 'key')
    .map(([k, v]) => ` ${ATTR_NAME[k] ?? k}="${esc(v)}"`)
    .join('')
  const inner = [].concat(children).map(toHtml).join('')
  if (VOID.has(type)) return `<${type}${attr}>`
  if (type === 'select') {
    // 静态 HTML 里 select 不认 value 属性，得把选中的 option 标出来（React 在宿主里自己做这件事）
    const want = props.value == null ? null : String(props.value)
    const kids = [].concat(children).map((c) => (c && c.type === 'option' && String(c.props ? c.props.value : '') === want
      ? { type: 'option', props: { ...(c.props || {}), selected: 'selected' }, children: c.children || [] }
      : c))
    return `<${type}${attr}>${kids.map(toHtml).join('')}</${type}>`
  }
  return `<${type}${attr}>${inner}</${type}>`
}

/** 明暗两块的 token 替身值。左边照宿主观感近似，右边同一批键换值——视图代码一个字不改。 */
const SHIM = {
  light: {
    '--dsw-alias-bg-base': '#fbfbfc', '--dsw-alias-bg-layer-1': '#ffffff', '--dsw-alias-bg-layer-2': '#f3f4f6',
    '--dsw-alias-bg-layer-3': '#e9ebef', '--dsw-alias-border-l1': '#e2e4e9', '--dsw-alias-border-l2': '#d2d5db',
    '--dsw-alias-border-l3': '#b9bdc6', '--dsw-alias-label-primary': '#1c1e22', '--dsw-alias-label-secondary': '#6b7280',
    '--dsw-alias-label-tertiary': '#8b919c', '--dsw-alias-label-dimmed': '#a8aeb8', '--dsw-alias-brand-primary': '#2f6f5e',
    '--dsw-alias-interactive-bg-hover': '#eceef2', '--dsw-alias-state-error-primary': '#a4443c',
    '--dsw-alias-state-success-primary': '#2f7d4f'
  },
  dark: {
    '--dsw-alias-bg-base': '#16171b', '--dsw-alias-bg-layer-1': '#1d1f24', '--dsw-alias-bg-layer-2': '#24272d',
    '--dsw-alias-bg-layer-3': '#2c3037', '--dsw-alias-border-l1': '#2e3138', '--dsw-alias-border-l2': '#3c4048',
    '--dsw-alias-border-l3': '#4a4f58', '--dsw-alias-label-primary': '#e6e8ec', '--dsw-alias-label-secondary': '#9aa1ac',
    '--dsw-alias-label-tertiary': '#7f8794', '--dsw-alias-label-dimmed': '#626a77', '--dsw-alias-brand-primary': '#78b8a4',
    '--dsw-alias-interactive-bg-hover': '#2a2e35', '--dsw-alias-state-error-primary': '#d47b73',
    '--dsw-alias-state-success-primary': '#6fbf8b'
  }
}

const shimBlock = () => Object.entries(SHIM)
  .map(([mode, map]) => `[data-preview="${mode}"]{${Object.entries(map).map(([k, v]) => `${k}:${v}`).join(';')};color-scheme:${mode}}`)
  .join('\n')

function page(title, blocks) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{margin:0;padding:18px 16px 28px;background:#101317;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.bl-head{color:#c7ccd4;font-size:13px;margin:0 0 4px}
.bl-cap{color:#9aa1ac;font-size:11px;margin:18px 0 7px}
.bl-note-preview{color:#7f8794;font-size:11px;margin:0 0 14px}
.bl-root{border-radius:10px;overflow:hidden;outline:1px solid #2a2e35}
${shimBlock()}
${CSS}
</style></head><body>
<p class="bl-head">Baleen 预览 · ${esc(title)}</p>
<p class="bl-note-preview">下面两块是同一次渲染的产物，只换 token 值。此处 token 用的是<b>替身</b>值（按宿主观感近似），真机以宿主主题为准。</p>
${blocks.map((b) => `<p class="bl-cap">${esc(b.label)}</p><div class="bl-root" data-preview="${b.mode}">${toHtml(b.node)}</div>`).join('\n')}
</body></html>
`
}

const both = (node, labels = ['明 · 宿主 token 替身值', '暗 · 只换 token 值，代码一个字没改']) => [
  { label: labels[0], node, mode: 'light' },
  { label: labels[1], node, mode: 'dark' }
]

/**
 * 外壳与真面板同构：异常带 + 顶部导航 + 主区 + 抽屉。
 * 预览里不给外壳的话，她没法看"像不像网站"这件事——而那正是当初定下来的布局。
 */
function shell({ view, state, body, drawer = null, problems = {} }) {
  return [
    TopBar(problems),
    Nav({ view, pending: (state && state.counts && state.counts.new) || 0 }),
    vnode('main', { className: 'bl-body' }, [body]),
    drawer
  ]
}

export function renderPreview({ outDir = path.join(ROOT, 'out'), empty = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const state = empty
    ? { counts: { new: 0, judged: 0, digest: 0, archived: 0, total: 0 }, digest_count: 0, sources: [], last_run: null, gaps: null, preference_errors: [] }
    : previewState
  const items = empty ? [] : previewItems
  const live = items.filter((i) => i.status !== 'archived')
  const drawerItem = items[0] ?? null
  const drawer = drawerItem
    ? Drawer({ item: drawerItem, api: {}, note: empty ? '' : 'demo-longform 权重 +0.1——只改 tuning，你的 themes 一个字没动' })
    : Drawer({ item: null, api: {} })
  const pages = {
    today: both(shell({ view: 'today', state, body: TodayView({ state, items: live, onRun: () => {}, onOpen: () => {}, onPickView: () => {} }) })),
    video: both(shell({ view: 'video', state, body: VideoView({ state, items, filters: empty ? {} : { tier: '' } }) })),
    article: both(shell({ view: 'article', state, body: ArticleView({ state, items, filters: {}, selectedId: items[4] ? items[4].id : null }) })),
    digest: both(shell({ view: 'digest', state, body: DigestView({ digests: [], state }) })),
    library: both(shell({ view: 'library', state, body: LibraryView({ items, filters: empty ? {} : { status: ['judged'] } }) })),
    drawer: both(shell({ view: 'today', state, body: TodayView({ state, items: live }), drawer, problems: { stale: true } })),
    trouble: both(shell({
      view: 'today',
      state,
      body: TodayView({ state: { ...state, sources: [{ id: 'demo-weekly', ok: false, error_class: 'timeout' }, { id: 'bili', ok: false, error_class: 'needs_login' }] }, items: [] }),
      problems: { runError: 'demo-weekly 超时（重试 1 次仍失败）', preferenceErrors: ['sources[3].max_age_days: ≥1 的整数'] }
    }))
  }
  return Object.entries(pages).map(([id, blocks]) => {
    const file = path.join(outDir, `preview-${id}.html`)
    fs.writeFileSync(file, page(id, blocks), 'utf8')
    return file
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('tools/preview.mjs')

if (isMain) {
  const files = renderPreview({})
  console.log(files.join('\n'))
}
