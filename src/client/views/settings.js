/**
 * 设置页（settings.section 槽）的四页签视图：源 / 偏好 / 凭据与环境 / 库。
 *
 * 与别的视图同一套规矩：纯函数，不发请求、不读 window，产 {type, props, children}；
 * 取数与草稿态全部由装配层（_footer.txt 的 SettingsView）持有并经 props 传进来。
 *
 * 三条本页特有的诚实底线：
 *  1. 偏好没读到（readOnly）时不画开关不放保存——盲 PUT sources 会把现有源整个抹掉；
 *  2. themes 的行格式只存得下 {group, any}：带必含/排除/权重的组不进文本、保存时原样并回
 *     （splitThemes），开了下设置页不等于把手编的高级条件悄悄抹掉；
 *  3. 坏行（theme/时间窗/数字/形态）当场标红并禁用保存——门在客户端，坏值根本轮不到发 PUT。
 */
import { vnode } from '../vnode.js'
import { fmtTime } from '../format.js'

export const SETTINGS_TABS = [['sources', '源'], ['pref', '偏好'], ['creds', '凭据与环境'], ['library', '库']]

/** 与宿主 lib/preference.js 的 WINDOW_RE 同一条：两边漂移就会"这边说好那边 400"。 */
const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
const KINDS = ['video', 'article', 'note']
const SOURCE_TYPES = ['rss', 'bili', 'yt']
const EMPTY_SRC_DRAFT = () => ({ id: '', type: 'rss', url: '', label: '', interval_min: '', weight: '' })

/* ---------------- 纯函数（导出给测试与装配层） ---------------- */

/** `组名: 词1,词2` 每行一组（全角冒号也认）。坏行不抛：带行号进 errors，让页签当场标红并禁保存。 */
export function parseThemes(text) {
  const errors = []
  const themes = []
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim()
    if (!raw) return
    const m = /^([^:：]{1,60})[:：]\s*(.*)$/.exec(raw)
    if (!m) { errors.push({ line: i + 1, text: raw, reason: '组名后面要跟半角或全角冒号' }); return }
    const group = m[1].trim()
    if (!group) { errors.push({ line: i + 1, text: raw, reason: '组名不能为空' }); return }
    const any = m[2].split(/[,，、]/).map((w) => w.trim()).filter(Boolean)
    if (!any.length) { errors.push({ line: i + 1, text: raw, reason: '至少一个主题词' }); return }
    themes.push({ group, any })
  })
  return { themes, errors }
}

export const serializeThemes = (themes) =>
  (themes ?? []).map((t) => `${t.group}: ${(t.any ?? []).join(',')}`).join('\n')

/**
 * 高级字段（must/never/weight≠1）在行格式里存不下：这批组不进文本编辑器，
 * 保存时原封不动并回去。宁可少给一个输入框，不悄悄丢用户手编的匹配条件。
 */
export function splitThemes(themes) {
  const simple = []
  const advanced = []
  for (const t of themes ?? []) {
    const isAdv = (t.must ?? []).length > 0 || (t.never ?? []).length > 0 || (t.weight != null && t.weight !== 1)
    ;(isAdv ? advanced : simple).push(t)
  }
  return { simple, advanced }
}

/** 逗号（中英文与顿号）与换行都算分隔的清单解析：排除词、跳过形态共用。 */
export const splitList = (text) =>
  String(text ?? '').split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean)

/** 源的"最近抓取"一句：/state 的 sources 里认得到的才说结果，认不到就说还没抓过。 */
export function lastFetchNote(stateSources, id) {
  const s = (stateSources ?? []).find((x) => x.id === id)
  if (!s) return '还没抓过（保存后下一轮才碰它）'
  if (s.ok) return '最近抓取：正常'
  if (s.error_class === 'needs_login') return '最近抓取：需要重新登录（去「凭据与环境」贴 cookie）'
  return `最近抓取：失败（${s.error_class ?? '未知'}），游标没推进，下轮自动补`
}

export function fmtBytes(n) {
  if (n == null) return '读不到'
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '读不到'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

const fmtDelta = (v) => (Number(v) > 0 ? `+${v}` : `${v}`)

/* ---------------- 小控件 ---------------- */

function Field({ label, hint, children }) {
  return vnode('div', { className: 'bl-setfield' }, [
    vnode('span', { className: 'bl-setlabel' }, [label]),
    ...children,
    hint ? vnode('span', { className: 'bl-sethint' }, [hint]) : null
  ].filter(Boolean))
}

const ERR = (lines) => lines.length
  ? vnode('ul', { className: 'bl-seterr' }, lines.map((e, i) => vnode('li', { key: i }, [e])))
  : null

function SaveBtn({ text, disabled, onClick }) {
  return vnode('button', { type: 'button', className: 'bl-setsave', disabled: disabled || undefined, onClick }, [text])
}

/* ---------------- 页签一：源 ---------------- */

function SourceRow({ s, status, confirming, busy, readOnly, onToggle, onAskDelete, onCancelDelete, onDelete }) {
  const name = `${s.id}（${s.type}${s.label ? ' · ' + s.label : ''}）`
  return vnode('div', { className: 'bl-srcrow', 'data-source': s.id, key: s.id }, [
    vnode('div', { className: 'bl-srcrow-head' }, [
      vnode('label', { className: 'bl-srctoggle' }, [
        vnode('input', {
          type: 'checkbox', 'aria-label': `启用 ${s.id}`,
          checked: s.enabled !== false, disabled: readOnly || busy || undefined,
          onChange: (e) => onToggle?.(s.id, Boolean(e?.target?.checked))
        }),
        name
      ]),
      confirming ? null : vnode('button', {
        type: 'button', disabled: readOnly || busy || undefined, onClick: () => onAskDelete?.(s.id)
      }, ['删除'])
    ].filter(Boolean)),
    vnode('div', { className: 'bl-card-meta' }, [
      `每 ${s.interval_min ?? 720} 分钟`,
      `权重 ${s.weight ?? 1}`,
      s.enabled === false ? '已停用' : '启用中'
    ]),
    vnode('div', { className: 'bl-kv' }, [status]),
    confirming
      ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': `确认删除源 ${s.id}` }, [
        vnode('p', {}, [`确认删除源 ${s.id}？只删配置（不再抓新的），已抓的条目不动、游标也保留。`]),
        vnode('button', { type: 'button', onClick: () => onCancelDelete?.() }, ['取消']),
        vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onDelete?.(s.id) }, ['确认删除'])
      ])
      : null
  ].filter(Boolean))
}

export function SourcesTab({ loaded, sources, pref, hostState, srcDraft = EMPTY_SRC_DRAFT(), onSrcDraft,
  askDelete = null, onAskDelete, onCancelDelete, onToggleSource, onAddSource, onDeleteSource, readOnly = false, busy = false }) {
  // sources 显式传入优先（装配层给的），纯函数调用时从 pref 里取——同一份形状，两个入口
  const list = Array.isArray(sources) ? sources : (Array.isArray(pref?.sources) ? pref.sources : [])
  const draftOk = String(srcDraft.id ?? '').trim() && String(srcDraft.url ?? '').trim()
  return vnode('div', { className: 'bl-setblock' }, [
    vnode('h4', {}, ['源（preference.yaml 的 sources 节，每次保存都是全量替换）']),
    ...list.map((s) => SourceRow({
      s,
      status: lastFetchNote(hostState?.sources, s.id),
      confirming: askDelete === s.id,
      busy, readOnly,
      onToggle: onToggleSource, onAskDelete, onCancelDelete, onDelete: onDeleteSource
    })),
    list.length ? null : vnode('p', { className: 'bl-empty' }, [
      loaded
        ? '一个源都还没配。用下面的表单加第一个（保存后下一轮抓取才碰它）。'
        : '源列表还没读到（宿主接口没应上）——读不到时不画开关也不许编辑，防半盲写把现有源抹掉。'
    ]),
    vnode('div', { className: 'bl-srcform' }, [
      vnode('input', { type: 'text', 'aria-label': '源 id', placeholder: '如 demo-weekly', value: srcDraft.id,
        disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ id: e?.target?.value ?? '' }) }),
      vnode('select', { 'aria-label': '源类型', value: srcDraft.type,
        onChange: (e) => onSrcDraft?.({ type: e?.target?.value ?? 'rss' }) },
        SOURCE_TYPES.map((t) => vnode('option', { key: t, value: t }, [t]))),
      vnode('input', { type: 'text', 'aria-label': '源 URL', placeholder: 'http(s) 地址 / UP 主 space 页', value: srcDraft.url,
        disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ url: e?.target?.value ?? '' }) }),
      vnode('input', { type: 'text', 'aria-label': '源标签（可选）', placeholder: '标签（可选）', value: srcDraft.label,
        disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ label: e?.target?.value ?? '' }) }),
      vnode('input', { type: 'number', 'aria-label': '抓取间隔（分钟，可选）', placeholder: '间隔分钟', value: srcDraft.interval_min,
        disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ interval_min: e?.target?.value ?? '' }) }),
      vnode('input', { type: 'number', 'aria-label': '源权重（可选）', placeholder: '权重 0–2', value: srcDraft.weight,
        disabled: readOnly || undefined, onChange: (e) => onSrcDraft?.({ weight: e?.target?.value ?? '' }) }),
      SaveBtn({ text: '新增源', disabled: readOnly || busy || !draftOk, onClick: () => onAddSource?.(srcDraft) })
    ])
  ].filter(Boolean))
}

/* ---------------- 页签二：偏好 ---------------- */

export function PrefsTab({ pref, themesDraft, onThemesDraft, redlinesDraft, onRedlinesDraft,
  scheduleDraft, onScheduleDraft, limitsDraft, onLimitsDraft, charterDraft, onCharterDraft,
  onSave, askResetTuning = false, onAskResetTuning, onCancelResetTuning, onResetTuning, readOnly = false, busy = false }) {
  // themes：行格式存得下的才进文本，高级组并回不丢
  const split = splitThemes(pref?.themes ?? [])
  const themesValue = themesDraft ?? serializeThemes(split.simple)
  const parsed = parseThemes(themesValue)
  const themesBad = parsed.errors.length > 0

  const redlinesValue = redlinesDraft ?? (pref?.redlines ?? []).join('\n')
  const sched = scheduleDraft ?? {
    windows: (pref?.schedule?.windows ?? []).join('\n'),
    max_per_run: String(pref?.schedule?.max_per_run ?? ''),
    max_per_day: String(pref?.schedule?.max_per_day ?? ''),
    off_peak_only: pref?.schedule?.off_peak_only !== false
  }
  const winLines = String(sched.windows ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const winErrs = winLines.filter((w) => !WINDOW_RE.test(w))
  const intOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
  const runN = intOf(sched.max_per_run)
  const dayN = intOf(sched.max_per_day)
  const schedBad = winErrs.length > 0 || runN == null || dayN == null || String(sched.max_per_run).trim() === '' || String(sched.max_per_day).trim() === ''
  const schedErrs = [
    ...winErrs.map((w) => `时间窗要写成 "07:00-09:00"：${w}`),
    ...(runN == null ? ['每轮上限要是正整数'] : []),
    ...(dayN == null ? ['每日上限要是正整数'] : [])
  ]

  const lim = limitsDraft ?? {
    max_age_days: String(pref?.limits?.max_age_days ?? ''),
    min_duration_sec: String(pref?.limits?.min_duration_sec ?? ''),
    skip_kinds: (pref?.limits?.skip_kinds ?? []).join(',')
  }
  const nnOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && String(v).trim() !== '' ? n : null }
  const ageN = nnOf(lim.max_age_days)
  const durN = nnOf(lim.min_duration_sec)
  const kinds = splitList(lim.skip_kinds)
  const badKinds = kinds.filter((k) => !KINDS.includes(k))
  const limBad = ageN == null || durN == null || badKinds.length > 0
  const limErrs = [
    ...(ageN == null ? ['最大保留天数要是非负整数'] : []),
    ...(durN == null ? ['最短时长要是非负整数'] : []),
    ...badKinds.map((k) => `跳过形态只有 video/article/note：${k}`)
  ]

  const charterValue = charterDraft ?? (pref?.charter ?? '')
  const delta = pref?.tuning?.source_delta ?? {}
  const deltaIds = Object.keys(delta).sort()
  const flag = (key, label, hint, value) => vnode('label', { className: 'bl-setflag' }, [
    vnode('input', {
      type: 'checkbox', 'aria-label': key, checked: value !== false, disabled: readOnly || busy || undefined,
      onChange: (e) => onSave?.(key, Boolean(e?.target?.checked), `${label}已更新`)
    }),
    label,
    hint ? vnode('span', { className: 'bl-sethint' }, [hint]) : null
  ].filter(Boolean))

  return vnode('div', { className: 'bl-setblock' }, [
    vnode('h4', {}, ['主题组（themes）']),
    Field({
      label: '每行一组：组名: 词1,词2（组内任一命中即算）',
      hint: '带必含/排除/权重的组这份格式存不下，去手编 preference.yaml；保存时它们原样保留。',
      children: [vnode('textarea', {
        'aria-label': '主题组', rows: 5, value: themesValue,
        disabled: readOnly || busy || undefined,
        onChange: (e) => onThemesDraft?.(e?.target?.value ?? '')
      })]
    }),
    split.advanced.length
      ? vnode('p', { className: 'bl-sethint' }, [
        `有 ${split.advanced.length} 组带必含/排除/权重字段（${split.advanced.map((t) => t.group).join('、')}），不进这个编辑框，保存时原样保留。`])
      : null,
    ERR(parsed.errors.map((e) => `第 ${e.line} 行：${e.reason}（${e.text}）`)),
    SaveBtn({ text: '保存主题组', disabled: readOnly || busy || themesBad,
      onClick: () => onSave?.('themes', [...split.advanced, ...parsed.themes], '主题组已存') }),

    vnode('h4', {}, ['排除词（redlines）']),
    Field({
      label: '逗号或换行分隔；命中即整条丢弃，优先于任何加分',
      children: [vnode('textarea', {
        'aria-label': '排除词', rows: 2, value: redlinesValue,
        disabled: readOnly || busy || undefined,
        onChange: (e) => onRedlinesDraft?.(e?.target?.value ?? '')
      })]
    }),
    SaveBtn({ text: '保存排除词', disabled: readOnly || busy,
      onClick: () => onSave?.('redlines', splitList(redlinesValue), '排除词已存') }),

    vnode('h4', {}, ['抓取时间窗（schedule）']),
    Field({
      label: '每行一个时间窗，写成 HH:MM-HH:MM',
      children: [
        vnode('textarea', {
          'aria-label': '时间窗', rows: 2, value: sched.windows,
          disabled: readOnly || busy || undefined,
          onChange: (e) => onScheduleDraft?.({ windows: e?.target?.value ?? '' })
        }),
        vnode('div', { className: 'bl-setrow' }, [
          vnode('input', { type: 'number', 'aria-label': '每轮上限', value: sched.max_per_run,
            disabled: readOnly || busy || undefined,
            onChange: (e) => onScheduleDraft?.({ max_per_run: e?.target?.value ?? '' }) }),
          vnode('input', { type: 'number', 'aria-label': '每日上限', value: sched.max_per_day,
            disabled: readOnly || busy || undefined,
            onChange: (e) => onScheduleDraft?.({ max_per_day: e?.target?.value ?? '' }) }),
          vnode('label', { className: 'bl-setflag' }, [
            vnode('input', {
              type: 'checkbox', 'aria-label': '只在时间窗内抓', checked: sched.off_peak_only,
              disabled: readOnly || busy || undefined,
              onChange: (e) => onScheduleDraft?.({ off_peak_only: Boolean(e?.target?.checked) })
            }),
            '只在时间窗内抓（off_peak_only）'
          ])
        ])
      ]
    }),
    ERR(schedErrs),
    SaveBtn({ text: '保存时间窗', disabled: readOnly || busy || schedBad,
      onClick: () => onSave?.('schedule', { windows: winLines, off_peak_only: sched.off_peak_only !== false, max_per_run: runN, max_per_day: dayN }, '时间窗已存') }),

    vnode('h4', {}, ['限额（limits）']),
    Field({
      label: '最大保留天数 / 最短时长（秒）/ 跳过形态（video/article/note，逗号分隔）',
      children: [vnode('div', { className: 'bl-setrow' }, [
        vnode('input', { type: 'number', 'aria-label': '最大保留天数', value: lim.max_age_days,
          disabled: readOnly || busy || undefined,
          onChange: (e) => onLimitsDraft?.({ max_age_days: e?.target?.value ?? '' }) }),
        vnode('input', { type: 'number', 'aria-label': '最短时长（秒）', value: lim.min_duration_sec,
          disabled: readOnly || busy || undefined,
          onChange: (e) => onLimitsDraft?.({ min_duration_sec: e?.target?.value ?? '' }) }),
        vnode('input', { type: 'text', 'aria-label': '跳过形态', placeholder: 'video,note（可空）', value: lim.skip_kinds,
          disabled: readOnly || busy || undefined,
          onChange: (e) => onLimitsDraft?.({ skip_kinds: e?.target?.value ?? '' }) })
      ])]
    }),
    ERR(limErrs),
    SaveBtn({ text: '保存限额', disabled: readOnly || busy || limBad,
      onClick: () => onSave?.('limits', { max_age_days: ageN, min_duration_sec: durN, skip_kinds: kinds }, '限额已存') }),

    vnode('h4', {}, ['判断开关']),
    flag('require_theme_hit', '没有命中任何主题组的条目直接丢弃', '关掉后全靠预筛分与源权重，条目会多很多', pref?.require_theme_hit),
    flag('inject_prompt', '每轮把待判清单注入会话（判断轮的触发器）', '关掉能省一点上下文', pref?.inject_prompt),

    vnode('h4', {}, ['章程（charter）']),
    Field({
      label: '写给判断那轮的话：给谁筛、什么算值得看',
      children: [vnode('textarea', {
        'aria-label': '章程', rows: 3, value: charterValue,
        disabled: readOnly || busy || undefined,
        onChange: (e) => onCharterDraft?.(e?.target?.value ?? '')
      })]
    }),
    SaveBtn({ text: '保存章程', disabled: readOnly || busy,
      onClick: () => onSave?.('charter', String(charterValue).replace(/\s+$/, ''), '章程已存') }),

    vnode('h4', {}, ['权重微调（tuning，只读展示）']),
    deltaIds.length
      ? vnode('ul', { className: 'bl-kv' }, deltaIds.map((id) => vnode('li', { key: id }, [`${id}: ${fmtDelta(delta[id])}`])))
      : vnode('p', { className: 'bl-kv' }, ['没有偏移']),
    vnode('p', { className: 'bl-sethint' }, ['偏移由面板上的「这源多来点 / 不感兴趣」写入（限幅 ±0.5），这里只能看和一键归零。']),
    askResetTuning
      ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认归零权重偏移' }, [
        vnode('p', {}, [`确认把 ${deltaIds.length} 处权重偏移全部归零？下一轮抓取就从零开始调。`]),
        vnode('button', { type: 'button', onClick: () => onCancelResetTuning?.() }, ['取消']),
        vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onResetTuning?.() }, ['确认归零'])
      ])
      : vnode('button', { type: 'button', className: 'bl-setsave', disabled: busy || undefined, onClick: () => onAskResetTuning?.() }, ['一键归零'])
  ].filter(Boolean))
}

/* ---------------- 页签三：凭据与环境 ---------------- */

export function CredsTab({ cred, env, cookieDraft = '', onCookieDraft, onCookieSubmit,
  diagText = null, onCopyDiag, busy = false }) {
  const bili = cred?.bili
  const cookieStatus = bili == null
    ? 'B 站 cookie：状态还没读到'
    : bili.present
      ? `B 站 cookie：已写入（更新于 ${fmtTime(bili.updated_at)}，内容不回显）`
      : 'B 站 cookie：还没写入'
  const envLines = env == null
    ? ['环境探测还没读到']
    : [
      `Node：${env.node ?? '—'}`,
      `yt-dlp：${env.yt_dlp ? env.yt_dlp : '没探测到（yt 源抓取会失败）'}`,
      `库大小：${fmtBytes(env.db_bytes)}`,
      `家目录：${env.home_writable === false ? '不可写（检查磁盘权限）' : '可写'}`
    ]
  return vnode('div', { className: 'bl-setblock' }, [
    vnode('h4', {}, ['B 站凭据']),
    vnode('p', { className: 'bl-kv' }, [cookieStatus]),
    Field({
      label: '从浏览器整段粘贴 cookie（写入后这里清空，内容永不回显）',
      hint: '文件落在本机 credentials/bili-cookie.txt，日志只记字节数。',
      children: [
        vnode('textarea', {
          'aria-label': 'B 站 cookie', rows: 3, placeholder: '整段粘进来', value: cookieDraft,
          disabled: busy || undefined, onChange: (e) => onCookieDraft?.(e?.target?.value ?? '')
        }),
        SaveBtn({ text: '写入 cookie', disabled: busy || !String(cookieDraft).trim(), onClick: () => onCookieSubmit?.(cookieDraft) })
      ]
    }),
    vnode('h4', {}, ['环境']),
    vnode('ul', { className: 'bl-kv' }, envLines.map((l, i) => vnode('li', { key: i }, [l]))),
    vnode('p', { className: 'bl-empty' }, ['小红书：未接入（M4b 待做）']),
    vnode('p', { className: 'bl-empty' }, ['转写依赖：未实现（随 ASR 一起）']),
    vnode('h4', {}, ['诊断']),
    vnode('div', { className: 'bl-setrow' }, [
      vnode('button', { type: 'button', className: 'bl-setsave', disabled: busy || undefined, onClick: () => onCopyDiag?.() },
        ['复制诊断（最近 50 行，已脱敏）'])
    ]),
    diagText != null ? vnode('pre', { className: 'bl-diagtext' }, [diagText]) : null
  ].filter(Boolean))
}

/* ---------------- 页签四：库 ---------------- */

export function LibTab({ home, cleanupDays = '', onCleanupDays, askCleanup = false, onAskCleanup,
  onCancelCleanup, onCleanup, wipeText = '', onWipeText, onWipe, onExport, readOnly = false, busy = false }) {
  const days = Number(cleanupDays)
  const daysOk = Number.isInteger(days) && days >= 1
  return vnode('div', { className: 'bl-setblock' }, [
    vnode('h4', {}, ['数据目录']),
    vnode('p', { className: 'bl-kv' }, [`数据目录：${home ?? '<HOME>'}/baleen（sqlite、日志、备份、导出都在这里）`]),
    vnode('h4', {}, ['导出']),
    vnode('p', { className: 'bl-sethint' }, ['全部条目按源分组写成 Markdown，落在 out/ 目录。']),
    SaveBtn({ text: '导出 Markdown（未判条目也全量带上）', disabled: readOnly || busy, onClick: () => onExport?.() }),
    vnode('h4', {}, ['按天数清理归档']),
    Field({
      label: '删除入库超过 N 天的归档条目（new/judged 不动，先自动备份）',
      children: [vnode('div', { className: 'bl-setrow' }, [
        vnode('input', { type: 'number', 'aria-label': '清理天数', placeholder: '如 30', value: cleanupDays,
          disabled: readOnly || busy || undefined,
          onChange: (e) => onCleanupDays?.(e?.target?.value ?? '') }),
        askCleanup
          ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认清理归档' }, [
            vnode('p', {}, [`将删除入库超过 ${cleanupDays} 天的归档条目（先自动备份）。已判与待判的不动。`]),
            vnode('button', { type: 'button', onClick: () => onCancelCleanup?.() }, ['取消']),
            vnode('button', { type: 'button', className: 'bl-danger', disabled: busy || undefined, onClick: () => onCleanup?.() }, ['确认清理'])
          ])
          : vnode('button', { type: 'button', className: 'bl-setsave', disabled: readOnly || busy || !daysOk || undefined,
            onClick: () => onAskCleanup?.() }, ['按天数清理'])
      ])]
    }),
    vnode('h4', {}, ['清空库（不可撤销，靠备份救）']),
    vnode('p', { className: 'bl-seterr' }, ['清空库：删除全部条目、抓取记录与汇报（先自动备份；收藏夹与游标保留）。']),
    Field({
      label: '输入「清空库」三个字，按钮才会亮',
      children: [vnode('div', { className: 'bl-setrow' }, [
        vnode('input', { type: 'text', 'aria-label': '清空库确认字', placeholder: '清空库', value: wipeText,
          disabled: busy || undefined,
          onChange: (e) => onWipeText?.(e?.target?.value ?? '') }),
        vnode('button', {
          type: 'button', className: 'bl-danger',
          disabled: busy || wipeText !== '清空库' || undefined,
          onClick: () => onWipe?.()
        }, ['清空库'])
      ])]
    })
  ].filter(Boolean))
}

/* ---------------- 顶层：页签条 + 当前页签 ---------------- */

export function SettingsPage(props) {
  const { tab = 'sources', onPickTab, note = '' } = props
  const body = tab === 'pref' ? PrefsTab(props)
    : tab === 'creds' ? CredsTab(props)
      : tab === 'library' ? LibTab(props)
        : SourcesTab(props)
  return vnode('div', { className: 'bl-settings' }, [
    vnode('aside', { className: 'bl-folderlist', 'aria-label': '设置页签' },
      SETTINGS_TABS.map(([id, label]) => vnode('button', {
        type: 'button', key: id, className: 'bl-foldertab', 'data-tab': id,
        'aria-current': tab === id ? 'page' : 'false',
        onClick: () => onPickTab?.(id)
      }, [label]))),
    vnode('div', { className: 'bl-settings-body' }, [
      note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
      body
    ].filter(Boolean))
  ])
}
