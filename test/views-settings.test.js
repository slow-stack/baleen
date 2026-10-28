import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPage, SourcesTab, PrefsTab, CredsTab, LibTab,
  parseThemes, serializeThemes, splitThemes, splitList, lastFetchNote, fmtBytes } from '../src/client/views/settings.js'
import { loadClient, exportsOf, flattenText } from '../tools/client-loader.mjs'
import { text, findAll } from './helpers/tree.mjs'

const PREF = {
  sources: [
    { id: 'demo-longform', type: 'rss', url: 'https://example.invalid/a', label: '长文', enabled: true, interval_min: 720, weight: 1 },
    { id: 'bili', type: 'bili', url: 'https://space.bilibili.com/123', enabled: false, interval_min: 1440 }
  ],
  themes: [{ group: '公共管理', any: ['治理', '订阅'] }, { group: '方法论', any: ['信息'] }],
  redlines: ['广告代理', '引流私聊'],
  schedule: { windows: ['07:00-09:00', '21:00-23:00'], off_peak_only: true, max_per_run: 25, max_per_day: 60 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: ['note'] },
  require_theme_hit: true, inject_prompt: true, charter: '写给关心公共管理的人',
  tuning: { source_delta: { 'demo-longform': 0.1, bili: -0.2 } }
}

const HOST_STATE = {
  home: '<HOME>',
  sources: [
    { id: 'demo-longform', ok: true, error_class: null },
    { id: 'bili', ok: false, error_class: 'needs_login' }
  ]
}

/** 控件查找：findAll 只认 className，这里按 aria-label 找 input/textarea/select/button */
function controls(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => controls(n, out)); return out }
  if (typeof node.type === 'function') return controls(node.type(node.props ?? {}), out)
  if (['input', 'textarea', 'select', 'button'].includes(node.type)) out.push(node)
  controls(node.children ?? [], out)
  return out
}
const byLabel = (tree, label) => controls(tree).find((n) => n.props['aria-label'] === label)
const btn = (tree, t) => controls(tree).find((n) => n.type === 'button' && text(n).includes(t))

/** 页面级 props 的最小可用集；各测试按需覆盖 */
const pageProps = (over = {}) => ({
  loaded: true, pref: PREF, hostState: HOST_STATE, note: '', busy: false,
  srcDraft: { id: '', type: 'rss', url: '', label: '', interval_min: '', weight: '' },
  onSrcDraft: () => {}, askDelete: null, onAskDelete: () => {}, onCancelDelete: () => {},
  onToggleSource: () => {}, onAddSource: () => {}, onDeleteSource: () => {},
  themesDraft: null, onThemesDraft: () => {}, redlinesDraft: null, onRedlinesDraft: () => {},
  scheduleDraft: null, onScheduleDraft: () => {}, limitsDraft: null, onLimitsDraft: () => {},
  charterDraft: null, onCharterDraft: () => {}, onSave: () => {},
  askResetTuning: false, onAskResetTuning: () => {}, onCancelResetTuning: () => {}, onResetTuning: () => {},
  cred: { bili: { present: true, updated_at: 7000 } },
  env: { node: '24.21.0', yt_dlp: '2026.10.12', bili_cookie: true, db_bytes: 2411724, home_writable: true },
  cookieDraft: '', onCookieDraft: () => {}, onCookieSubmit: () => {}, diagText: null, onCopyDiag: () => {},
  home: '<HOME>', cleanupDays: '', onCleanupDays: () => {}, askCleanup: false, onAskCleanup: () => {},
  onCancelCleanup: () => {}, onCleanup: () => {}, wipeText: '', onWipeText: () => {}, onWipe: () => {}, onExport: () => {},
  ...over
})

/* ---------------- 页签条与四页签路由 ---------------- */

test('四页签 tab 条照收藏页 foldertab 样式：aria-current 标当前格，点击交 id', () => {
  const picked = []
  const tree = SettingsPage(pageProps({ tab: 'pref', onPickTab: (id) => picked.push(id) }))
  const tabs = findAll(tree, 'bl-foldertab')
  assert.deepEqual(tabs.map((t) => t.props['data-tab']), ['sources', 'pref', 'creds', 'library'])
  assert.deepEqual(tabs.map((t) => text(t)), ['源', '偏好', '凭据与环境', '库'])
  assert.deepEqual(tabs.map((t) => t.props['aria-current']), ['false', 'page', 'false', 'false'])
  tabs[3].props.onClick()
  assert.deepEqual(picked, ['library'])
})

test('四个页签各自渲染自己的那块：tab 换格内容跟着换', () => {
  const byTab = (tab) => text(SettingsPage(pageProps({ tab })))
  assert.match(byTab('sources'), /demo-longform/)
  assert.doesNotMatch(byTab('sources'), /主题组/)
  assert.match(byTab('pref'), /主题组/)
  assert.match(byTab('creds'), /B 站 cookie/)
  assert.match(byTab('library'), /数据目录/)
  assert.doesNotMatch(byTab('library'), /主题组/)
})

test('note 有话要说时占一行（role=status），没话不占', () => {
  const withNote = SettingsPage(pageProps({ note: '主题组已存' }))
  assert.equal(findAll(withNote, 'bl-feedback').length, 1)
  assert.match(text(withNote), /主题组已存/)
  assert.equal(findAll(SettingsPage(pageProps({ note: '' })), 'bl-feedback').length, 0)
})

/* ---------------- 页签一：源 ---------------- */

test('源列表行：id·类型·label·开关·间隔·权重都在，停用的源开关是空的', () => {
  const tree = SettingsPage(pageProps({ tab: 'sources' }))
  const t = text(tree)
  assert.match(t, /demo-longform（rss · 长文）/)
  assert.match(t, /bili（bili）/)
  assert.match(t, /每 720 分钟/)
  assert.match(t, /权重 1/)
  assert.equal(byLabel(tree, '启用 demo-longform').props.checked, true)
  assert.equal(byLabel(tree, '启用 bili').props.checked, false)
})

test('开关即交 id 与新值（装配层据此 PUT 全量 sources）', () => {
  const toggled = []
  const tree = SettingsPage(pageProps({ tab: 'sources', onToggleSource: (id, next) => toggled.push([id, next]) }))
  byLabel(tree, '启用 bili').props.onChange({ target: { checked: true } })
  assert.deepEqual(toggled, [['bili', true]])
})

test('最近抓取一句：正常 / 需要重新登录 / 还没抓过 / 失败游标不推进，四种说法不同', () => {
  assert.equal(lastFetchNote(HOST_STATE.sources, 'demo-longform'), '最近抓取：正常')
  assert.equal(lastFetchNote(HOST_STATE.sources, 'bili'), '最近抓取：需要重新登录（去「凭据与环境」贴 cookie）')
  assert.equal(lastFetchNote(HOST_STATE.sources, 'rss-new'), '还没抓过（保存后下一轮才碰它）')
  assert.equal(lastFetchNote([{ id: 'x', ok: false, error_class: 'timeout' }], 'x'), '最近抓取：失败（timeout），游标没推进，下轮自动补')
  const tree = SettingsPage(pageProps({ tab: 'sources' }))
  assert.match(text(tree), /最近抓取：正常/)
  assert.match(text(tree), /最近抓取：需要重新登录/)
})

test('删源是二次确认：第一次点只亮确认框，确认前不动手，确认按钮是 danger', () => {
  const asked = [], deleted = []
  const tree = SettingsPage(pageProps({ tab: 'sources', onAskDelete: (id) => asked.push(id), onDelete: (id) => deleted.push(id) }))
  btn(tree, '删除').props.onClick()
  assert.deepEqual(asked, ['demo-longform'])
  assert.equal(deleted.length, 0, '第一次点就把源删了，二次确认形同虚设')
  const confirming = SettingsPage(pageProps({ tab: 'sources', askDelete: 'demo-longform', onCancelDelete: () => {}, onDeleteSource: (id) => deleted.push(id) }))
  const box = findAll(confirming, 'bl-confirm')[0]
  assert.match(text(box), /只删配置/)
  assert.match(text(box), /已抓的条目不动/)
  const danger = box.children.filter((b) => b.type === 'button').find((b) => text(b).includes('确认删除'))
  assert.equal(danger.props.className, 'bl-danger')
  danger.props.onClick()
  assert.deepEqual(deleted, ['demo-longform'])
})

test('新增源表单：类型枚举 rss|bili|yt，url 空着不亮钮，填好把草稿整份交出去', () => {
  const added = []
  const draft = { id: 'yt-docs', type: 'yt', url: '', label: '', interval_min: '', weight: '' }
  const empty = SettingsPage(pageProps({ tab: 'sources', srcDraft: draft, onAddSource: (d) => added.push(d) }))
  const sel = byLabel(empty, '源类型')
  assert.deepEqual(sel.children.map((o) => o.props.value), ['rss', 'bili', 'yt'])
  assert.equal(btn(empty, '新增源').props.disabled, true, 'url 必填：空着就该是禁用的')
  const filled = SettingsPage(pageProps({ tab: 'sources', srcDraft: { ...draft, url: 'https://example.invalid/videos' }, onAddSource: (d) => added.push(d) }))
  assert.equal(btn(filled, '新增源').props.disabled, undefined)
  btn(filled, '新增源').props.onClick()
  assert.deepEqual(added, [{ id: 'yt-docs', type: 'yt', url: 'https://example.invalid/videos', label: '', interval_min: '', weight: '' }])
})

test('偏好还没读到时整个源页签是只读的：一个 PUT 都不许发（防半盲写抹掉现有源）', () => {
  const tree = SettingsPage(pageProps({ tab: 'sources', loaded: false, pref: null }))
  assert.match(text(tree), /还没读到/)
  assert.equal(byLabel(tree, '启用 demo-longform'), undefined, '读不到源列表时连开关都不画，画了就是在赌')
  assert.equal(btn(tree, '新增源').props.disabled, true)
})

/* ---------------- 页签二：偏好 ---------------- */

test('parseThemes：好行成组、全角冒号也认、空行跳过、坏行带行号不混进结果', () => {
  const good = parseThemes('公共管理: 治理,订阅\n方法论：信息 、 界面\n\n手编: x')
  assert.deepEqual(good.errors, [])
  assert.deepEqual(good.themes, [
    { group: '公共管理', any: ['治理', '订阅'] },
    { group: '方法论', any: ['信息', '界面'] },
    { group: '手编', any: ['x'] }
  ])
  const bad = parseThemes('公共管理: 治理\n这行没有冒号\n: 只有词\n空组: ')
  assert.deepEqual(bad.themes, [{ group: '公共管理', any: ['治理'] }])
  assert.equal(bad.errors.length, 3)
  assert.equal(bad.errors[0].line, 2)
  assert.match(bad.errors[0].reason, /组名/)
  assert.match(bad.errors[1].reason, /组名/)
  assert.match(bad.errors[2].reason, /至少一个主题词/)
  const empty = parseThemes('')
  assert.deepEqual(empty, { themes: [], errors: [] })
})

test('serializeThemes 逐字输出，与 parseThemes 互为往返', () => {
  assert.equal(serializeThemes([{ group: '公共管理', any: ['治理', '订阅'] }]), '公共管理: 治理,订阅')
  assert.equal(serializeThemes([]), '')
  const round = parseThemes(serializeThemes(PREF.themes))
  assert.deepEqual(round.themes, PREF.themes)
  assert.deepEqual(round.errors, [])
})

test('splitThemes：带必含/排除/权重的组不进文本编辑器，保存时原样并回（开了设置页不等于抹掉手编高级条件）', () => {
  const themes = [
    { group: '简单组', any: ['a'] },
    { group: '必含组', any: ['b'], must: ['x'] },
    { group: '排除组', any: ['c'], never: ['y'] },
    { group: '权重组', any: ['d'], weight: 1.5 },
    { group: '权重还是一', any: ['e'], weight: 1 }
  ]
  const split = splitThemes(themes)
  assert.deepEqual(split.simple.map((t) => t.group), ['简单组', '权重还是一'])
  assert.deepEqual(split.advanced.map((t) => t.group), ['必含组', '排除组', '权重组'])
  // 视图：高级组不进 textarea，但要在旁边说清楚"存不下、会原样保留"
  const saved = []
  const tree = SettingsPage(pageProps({ tab: 'pref', pref: { ...PREF, themes }, onSave: (s, v) => saved.push([s, v]) }))
  const ta = byLabel(tree, '主题组')
  assert.match(ta.props.value, /简单组/)
  assert.doesNotMatch(ta.props.value, /必含组/)
  assert.match(text(tree), /3 组带必含\/排除\/权重字段/)
  assert.match(text(tree), /原样保留/)
  btn(tree, '保存主题组').props.onClick()
  assert.equal(saved[0][0], 'themes')
  assert.deepEqual(saved[0][1].map((t) => t.group), ['必含组', '排除组', '权重组', '简单组', '权重还是一'], '高级组一个不少地并回去')
})

test('坏 theme 行当场标红且保存禁用——门在客户端，PUT 根本轮不到发', () => {
  const saved = []
  const bad = SettingsPage(pageProps({ tab: 'pref', themesDraft: '好组: a\n这行是坏的', onSave: (s, v) => saved.push([s, v]) }))
  assert.equal(btn(bad, '保存主题组').props.disabled, true)
  assert.equal(findAll(bad, 'bl-seterr').length > 0, true)
  assert.match(text(findAll(bad, 'bl-seterr')[0]), /第 2 行/)
  const good = SettingsPage(pageProps({ tab: 'pref', themesDraft: '好组: a', onSave: (s, v) => saved.push([s, v]) }))
  assert.equal(btn(good, '保存主题组').props.disabled, undefined)
  btn(good, '保存主题组').props.onClick()
  // 草稿是整份替换：textarea 里的解析结果（高级组并回）就是新的 themes
  assert.deepEqual(saved, [['themes', [{ group: '好组', any: ['a'] }]]])
})

test('偏好页其余各节：草稿回落现值，保存交整节；坏值（时间窗/数字/跳过形态）禁用保存', () => {
  const saved = []
  const tree = SettingsPage(pageProps({ tab: 'pref', onSave: (s, v) => saved.push([s, v]) }))
  // 草稿没动过时回落 preference 现值
  assert.equal(byLabel(tree, '排除词').props.value, '广告代理\n引流私聊')
  assert.equal(byLabel(tree, '时间窗').props.value, '07:00-09:00\n21:00-23:00')
  assert.equal(byLabel(tree, '每轮上限').props.value, '25')
  assert.equal(byLabel(tree, '最大保留天数').props.value, '14')
  assert.equal(byLabel(tree, '跳过形态').props.value, 'note')
  assert.equal(byLabel(tree, '章程').props.value, '写给关心公共管理的人')
  // 各节保存把结构化的整节交出去
  btn(tree, '保存排除词').props.onClick()
  assert.deepEqual(saved.at(-1), ['redlines', ['广告代理', '引流私聊']])
  btn(tree, '保存时间窗').props.onClick()
  assert.deepEqual(saved.at(-1), ['schedule', { windows: ['07:00-09:00', '21:00-23:00'], off_peak_only: true, max_per_run: 25, max_per_day: 60 }])
  btn(tree, '保存限额').props.onClick()
  assert.deepEqual(saved.at(-1), ['limits', { max_age_days: 14, min_duration_sec: 90, skip_kinds: ['note'] }])
  btn(tree, '保存章程').props.onClick()
  assert.deepEqual(saved.at(-1), ['charter', '写给关心公共管理的人'])
  // 坏值当场拦：坏时间窗、非正整数、不认识的形态
  const badWin = SettingsPage(pageProps({ tab: 'pref', scheduleDraft: { windows: '7点-9点', max_per_run: '25', max_per_day: '60', off_peak_only: true } }))
  assert.equal(btn(badWin, '保存时间窗').props.disabled, true)
  assert.match(text(findAll(badWin, 'bl-seterr')[0]), /时间窗/)
  const badNum = SettingsPage(pageProps({ tab: 'pref', scheduleDraft: { windows: '07:00-09:00', max_per_run: 'abc', max_per_day: '60', off_peak_only: true } }))
  assert.equal(btn(badNum, '保存时间窗').props.disabled, true)
  const badKind = SettingsPage(pageProps({ tab: 'pref', limitsDraft: { max_age_days: '14', min_duration_sec: '90', skip_kinds: 'podcast' } }))
  assert.equal(btn(badKind, '保存限额').props.disabled, true)
  assert.match(text(findAll(badKind, 'bl-seterr')[0]), /podcast/)
})

test('splitList：逗号/中文逗号/换行都算分隔，空段滤掉', () => {
  assert.deepEqual(splitList('a, b，\nc  ,,'), ['a', 'b', 'c'])
  assert.deepEqual(splitList(''), [])
  assert.deepEqual(splitList(null), [])
})

test('两个开关即时交整节布尔（require_theme_hit / inject_prompt）', () => {
  const saved = []
  const tree = SettingsPage(pageProps({ tab: 'pref', onSave: (s, v) => saved.push([s, v]) }))
  assert.equal(byLabel(tree, 'require_theme_hit').props.checked, true)
  assert.equal(byLabel(tree, 'inject_prompt').props.checked, true)
  byLabel(tree, 'require_theme_hit').props.onChange({ target: { checked: false } })
  byLabel(tree, 'inject_prompt').props.onChange({ target: { checked: false } })
  assert.deepEqual(saved, [['require_theme_hit', false], ['inject_prompt', false]])
})

test('tuning 一览：每行 源id: ±值，空则一句"没有偏移"；归零前有确认门', () => {
  const reset = []
  const tree = SettingsPage(pageProps({ tab: 'pref', onResetTuning: () => reset.push(1) }))
  assert.match(text(tree), /demo-longform: \+0\.1/)
  assert.match(text(tree), /bili: -0\.2/)
  btn(tree, '一键归零').props.onClick()
  assert.equal(reset.length, 0, '点一下就归零，确认形同虚设')
  const armed = SettingsPage(pageProps({ tab: 'pref', askResetTuning: true, onResetTuning: () => reset.push(1) }))
  const box = findAll(armed, 'bl-confirm')[0]
  assert.match(text(box), /2 处权重偏移/)
  box.children.filter((b) => b.type === 'button').find((b) => text(b).includes('确认归零')).props.onClick()
  assert.deepEqual(reset, [1])
  const none = SettingsPage(pageProps({ tab: 'pref', pref: { ...PREF, tuning: { source_delta: {} } } }))
  assert.match(text(none), /没有偏移/)
})

/* ---------------- 页签三：凭据与环境 ---------------- */

test('cookie 状态行：已写入带更新时间且声明不回显；未写入与没读到说法不同', () => {
  const tree = SettingsPage(pageProps({ tab: 'creds' }))
  assert.match(text(tree), /B 站 cookie：已写入/)
  assert.match(text(tree), /内容不回显/)
  const absent = text(SettingsPage(pageProps({ tab: 'creds', cred: { bili: { present: false, updated_at: null } } })))
  assert.match(absent, /还没写入/)
  const unread = text(SettingsPage(pageProps({ tab: 'creds', cred: null })))
  assert.match(unread, /状态还没读到/)
  assert.doesNotMatch(unread, /还没写入/, '把"没读到"说成"没写入"是把失败说成空的谎')
})

test('cookie 粘贴框：空草稿不亮写入钮；文字交回装配层', () => {
  const typed = [], submitted = []
  const tree = SettingsPage(pageProps({ tab: 'creds', cookieDraft: '', onCookieDraft: (v) => typed.push(v), onCookieSubmit: (v) => submitted.push(v) }))
  assert.equal(btn(tree, '写入 cookie').props.disabled, true)
  const filled = SettingsPage(pageProps({ tab: 'creds', cookieDraft: 'SESSDATA=x', onCookieDraft: (v) => typed.push(v), onCookieSubmit: (v) => submitted.push(v) }))
  assert.equal(byLabel(filled, 'B 站 cookie').props.value, 'SESSDATA=x')
  btn(filled, '写入 cookie').props.onClick()
  assert.deepEqual(submitted, ['SESSDATA=x'])
  assert.equal(typed.length, 0)
  byLabel(filled, 'B 站 cookie').props.onChange({ target: { value: 'SESSDATA=y' } })
  assert.deepEqual(typed, ['SESSDATA=y'])
})

test('env-check 四行：node/yt-dlp/库大小/家目录，缺的说不缺的谎', () => {
  assert.equal(fmtBytes(2411724), '2.3 MB')
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(2048), '2.0 KB')
  assert.equal(fmtBytes(null), '读不到')
  const tree = SettingsPage(pageProps({ tab: 'creds' }))
  const t = text(tree)
  assert.match(t, /Node：24\.21\.0/)
  assert.match(t, /yt-dlp：2026\.10\.12/)
  assert.match(t, /库大小：2\.3 MB/)
  assert.match(t, /家目录：可写/)
  const broken = text(SettingsPage(pageProps({ tab: 'creds', env: { node: '24.21.0', yt_dlp: null, db_bytes: null, home_writable: false } })))
  assert.match(broken, /yt-dlp：没探测到/)
  assert.match(broken, /库大小：读不到/)
  assert.match(broken, /家目录：不可写/)
  const unread = text(SettingsPage(pageProps({ tab: 'creds', env: null })))
  assert.match(unread, /环境探测还没读到/)
})

test('xhs 与 ASR 的诚实占位逐字：未接入不做假按钮', () => {
  const t = text(SettingsPage(pageProps({ tab: 'creds' })))
  assert.match(t, /小红书：未接入/)
  assert.match(t, /转写依赖：未实现（随 ASR 一起）/)
  assert.doesNotMatch(t, /扫码/)
})

test('复制诊断：按钮在；clipboard 不行时降级成文本块（可手动复制）', () => {
  const copied = []
  const tree = SettingsPage(pageProps({ tab: 'creds', onCopyDiag: () => copied.push(1) }))
  assert.match(text(btn(tree, '复制诊断')), /已脱敏/)
  btn(tree, '复制诊断').props.onClick()
  assert.deepEqual(copied, [1])
  const fallback = SettingsPage(pageProps({ tab: 'creds', diagText: '{"event":"run"}\n{"event":"collect"}' }))
  assert.equal(findAll(fallback, 'bl-diagtext').length, 1)
  assert.match(text(findAll(fallback, 'bl-diagtext')[0]), /"event":"collect"/)
})

/* ---------------- 页签四：库 ---------------- */

test('数据目录用 <HOME> 占位，不漏真实家目录', () => {
  const t = text(SettingsPage(pageProps({ tab: 'library' })))
  assert.match(t, /数据目录：<HOME>\/baleen/)
})

test('导出按钮交回装配层（回执文件名与字节数由装配层写进 note）', () => {
  const exported = []
  const tree = SettingsPage(pageProps({ tab: 'library', onExport: () => exported.push(1) }))
  assert.match(text(btn(tree, '导出 Markdown')), /未判/)
  btn(tree, '导出 Markdown').props.onClick()
  assert.deepEqual(exported, [1])
})

test('按天数清理：非法天数不亮钮；点清理先过确认门，确认前不动手', () => {
  const armed = [], cleaned = []
  const bad = SettingsPage(pageProps({ tab: 'library', cleanupDays: 'abc', onAskCleanup: () => armed.push(1), onCleanup: () => cleaned.push(1) }))
  assert.equal(btn(bad, '按天数清理').props.disabled, true)
  const zero = SettingsPage(pageProps({ tab: 'library', cleanupDays: '0', onAskCleanup: () => armed.push(1), onCleanup: () => cleaned.push(1) }))
  assert.equal(btn(zero, '按天数清理').props.disabled, true)
  const okTree = SettingsPage(pageProps({ tab: 'library', cleanupDays: '30', onAskCleanup: () => armed.push(1), onCleanup: () => cleaned.push(1) }))
  assert.equal(btn(okTree, '按天数清理').props.disabled, undefined)
  btn(okTree, '按天数清理').props.onClick()
  assert.deepEqual(armed, [1])
  assert.equal(cleaned.length, 0, '第一次点就删，确认门形同虚设')
  const confirming = SettingsPage(pageProps({ tab: 'library', cleanupDays: '30', askCleanup: true, onCleanup: () => cleaned.push(1) }))
  const box = findAll(confirming, 'bl-confirm')[0]
  assert.match(text(box), /30 天/)
  assert.match(text(box), /先自动备份/)
  box.children.filter((b) => b.type === 'button').find((b) => text(b).includes('确认清理')).props.onClick()
  assert.deepEqual(cleaned, [1])
})

test('清空库字面量门：错一个字都不亮钮，亮了的是红字 danger；说明行也是红字', () => {
  const wiped = []
  const gate = (wipeText) => SettingsPage(pageProps({ tab: 'library', wipeText, onWipe: () => wiped.push(1) }))
  assert.equal(btn(gate(''), '清空库').props.disabled, true)
  assert.equal(btn(gate('清空'), '清空库').props.disabled, true)
  assert.equal(btn(gate('清空库 '), '清空库').props.disabled, true, '带空格不算——确认词必须是无歧义的原样输入')
  const armedTree = gate('清空库')
  const wbtn = btn(armedTree, '清空库')
  assert.equal(wbtn.props.disabled, undefined)
  assert.equal(wbtn.props.className, 'bl-danger')
  wbtn.props.onClick()
  assert.deepEqual(wiped, [1])
  assert.match(text(findAll(armedTree, 'bl-seterr')[0]), /先自动备份/)
  assert.match(text(armedTree), /收藏夹/)
})

test('库页签没读到状态时数据目录仍显示占位而不是空白（目录名是常量，不依赖接口）', () => {
  const t = text(SettingsPage(pageProps({ tab: 'library', home: null })))
  assert.match(t, /数据目录：<HOME>\/baleen/)
})

/* ---------------- 装配层接线（真客户端，带 hooks 的小 runtime） ---------------- */

/**
 * 与 client-boot.test.js 同款的最小 hook runtime：桩的 useState 永不重渲染、useEffect 从不执行，
 * 不补这两个，"设置页真的消费取数、真的发 PUT"永远测不出来。
 * 测完立刻还原：该 React 对象跨测试共享。
 */
function hookRuntime(React, Comp) {
  const orig = { useState: React.useState, useEffect: React.useEffect }
  const states = []
  const pending = []
  let cursor = 0
  let mounted = false
  React.useState = (init) => {
    const i = cursor++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }]
  }
  React.useEffect = (fn) => { if (!mounted) pending.push(fn) }
  return {
    render() { cursor = 0; const tree = Comp(); if (!mounted) { mounted = true; for (const fn of pending.splice(0)) fn() } return tree },
    flush: () => new Promise((r) => setTimeout(r, 0)),
    restore() { Object.assign(React, orig) }
  }
}

const settingsFetch = ({ responses = {} } = {}) => {
  const calls = []
  const json = {
    '/preference': { ok: true, pref: PREF, errors: [] },
    '/state': { ok: true, ...HOST_STATE, counts: { new: 0 }, preference_errors: [] },
    '/credential-status': { ok: true, bili: { present: false, updated_at: null } },
    '/env-check': { ok: true, node: '24.21.0', yt_dlp: null, bili_cookie: false, db_bytes: 1024, home_writable: true },
    ...responses
  }
  const fetchImpl = async (url, init = {}) => {
    const key = String(url).replace('/api/dsh-baleen', '').split('?')[0]
    calls.push({ key, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    return { ok: true, status: 200, json: async () => json[key] ?? { ok: true } }
  }
  return { calls, fetchImpl }
}

test('设置页真的消费取数：首渲染挂起效果，取数落地后源列表上页', async () => {
  const { fetchImpl } = settingsFetch()
  const s = loadClient({ fetchImpl })
  const rt = hookRuntime(s.React, exportsOf(s).__test.SettingsView)
  try {
    const first = rt.render()
    assert.match(text(first), /还没读到/, '取数落地前不许假装读到了源')
    await rt.flush()
    const second = rt.render()
    assert.match(text(second), /demo-longform（rss · 长文）/)
    assert.match(text(second), /最近抓取：正常/)
    // 切到凭据页签：状态行也在（credential-status 的应答被消费了）
    findAll(second, 'bl-foldertab')[2].props.onClick()
    assert.match(text(rt.render()), /B 站 cookie：还没写入/)
  } finally { rt.restore() }
})

test('源的开关走读-改-写：PUT /preference 带全量 sources，被点的那个翻 enabled', async () => {
  const { calls, fetchImpl } = settingsFetch({ responses: { '/credential': { ok: true, bili: { present: true, updated_at: 9000 } } } })
  const s = loadClient({ fetchImpl })
  const rt = hookRuntime(s.React, exportsOf(s).__test.SettingsView)
  try {
    rt.render()
    await rt.flush()
    byLabel(rt.render(), '启用 bili').props.onChange({ target: { checked: true } })
    await rt.flush()
    const put = calls.find((c) => c.key === '/preference' && c.method === 'PUT')
    assert.ok(put, '开关没发出 PUT')
    assert.equal(put.body.section, 'sources')
    assert.deepEqual(put.body.value.map((x) => [x.id, x.enabled === false ? false : Boolean(x.enabled)]),
      [['demo-longform', true], ['bili', true]], 'PUT 必须是全量数组（读-改-写），不是只发那一个源')
  } finally { rt.restore() }
})

test('坏 preference.yaml 上 GET 退默认也要把 errors 亮出来——不把假默认当真配置', async () => {
  const { fetchImpl } = settingsFetch({
    responses: { '/preference': { ok: false, pref: { sources: [] }, errors: ['themes[0].weight: 0–2', 'sources[1].interval_min: ≥15 的整数'] } }
  })
  const s = loadClient({ fetchImpl })
  const rt = hookRuntime(s.React, exportsOf(s).__test.SettingsView)
  try {
    rt.render()
    await rt.flush()
    const t = text(rt.render())
    assert.match(t, /preference\.yaml 有 2 处问题/)
    assert.match(t, /themes\[0\]\.weight/)
    assert.match(t, /先手编修好/, '坏文件期间的保存会被拒，这句要提前说')
  } finally { rt.restore() }
})

test('cookie 粘贴写入成功后输入框清空，应答与界面都零回显', async () => {
  const { calls, fetchImpl } = settingsFetch({ responses: { '/credential': { ok: true, bili: { present: true, updated_at: 9000 } } } })
  const s = loadClient({ fetchImpl })
  const rt = hookRuntime(s.React, exportsOf(s).__test.SettingsView)
  try {
    rt.render()
    await rt.flush()
    rt.render()
    // 切到凭据页签再操作（tab state 在装配层）
    findAll(rt.render(), 'bl-foldertab')[2].props.onClick()
    const ta = byLabel(rt.render(), 'B 站 cookie')
    ta.props.onChange({ target: { value: 'SESSDATA=abc123' } })
    btn(rt.render(), '写入 cookie').props.onClick()
    await rt.flush()
    const put = calls.find((c) => c.key === '/credential' && c.method === 'PUT')
    assert.deepEqual(put.body, { which: 'bili', content: 'SESSDATA=abc123' })
    const after = rt.render()
    assert.equal(byLabel(after, 'B 站 cookie').props.value, '', '写入成功后输入框要清空')
    assert.match(text(after), /已写入/)
    assert.doesNotMatch(text(after), /SESSDATA/, '界面零回显：cookie 内容一个字都不许再出现')
  } finally { rt.restore() }
})
