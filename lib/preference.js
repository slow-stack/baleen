import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { homeDir } from './paths.js'

const FILE = 'preference.yaml'
/** 模板与 writePreference 共用的文件头注释：写回时没有用户注释就带这句 */
const FILE_HEADER = '# 改这里：themes / follow / sources 是你的，tuning 只由面板那两个按钮写。\n'
const CLAMP = 0.5
const KNOWN_TYPES = ['rss', 'bili', 'yt']   // xhs 由后续计划登记进来
const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

export const DEFAULTS = {
  version: 1,
  themes: [],
  follow: { feeds: [] },
  sources: [],
  schedule: { windows: ['07:00-09:00', '12:30-13:30'], off_peak_only: true, max_per_run: 25, max_per_day: 60 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  require_theme_hit: true,
  inject_prompt: true,
  tuning: { source_delta: {} },
  redlines: ['广告代理', '引流私聊', '付费课程推销'],
  charter: '',
  yt_dlp_path: 'yt-dlp',       // yt 源（M4b）的 yt-dlp 可执行名/路径，缺省走 PATH
  network: { proxy: '' }       // 只传给 yt-dlp 的 --proxy，不动全局 fetch；空 = 不走代理
}

export function prefFile(dir = homeDir()) {
  return path.join(dir, FILE)
}

/**
 * 面板两个按钮的落点。为什么不写 preference.yaml：
 * YAML.stringify 会重排整个文件并丢掉注释，而那是用户手编辑的东西
 * ——「点一下不感兴趣」不该把你的配置文件改成另一副样子。
 * 加载时按 { ...yaml 里的 tuning, ...tuning.json } 合并，json 赢。
 */
export function tuningFile(dir = homeDir()) {
  return path.join(dir, 'tuning.json')
}

export function readTuning(dir = homeDir()) {
  try {
    const t = fs.readFileSync(tuningFile(dir), 'utf8')
    const obj = JSON.parse(t)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => Number.isFinite(v) && Math.abs(v) <= CLAMP))
  } catch { return {} }
}

/** 就地累加某源的权重偏移并落盘，返回合并后的整张表（限幅 ±0.5） */
export function bumpTuningFile(dir, sourceId, delta) {
  const cur = readTuning(dir)
  const next = Math.max(-CLAMP, Math.min(CLAMP, Math.round(((Number(cur[sourceId]) || 0) + delta) * 100) / 100))
  if (next === 0) delete cur[sourceId]
  else cur[sourceId] = next
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tuningFile(dir), `${JSON.stringify(cur, null, 2)}\n`, 'utf8')
  return cur
}

export function ensurePreferenceFile(dir = homeDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, FILE_HEADER + YAML.stringify(DEFAULTS), 'utf8')
  }
  return target
}

/**
 * 设置页 PUT 的落点：原子写（同目录 tmp + rename——跨目录 rename 不原子，tmp 必须挨着目标）。
 * 文件头注释原样带回：首行以 # 开头就用用户的，没有就带模板那句；其余注释保不住是
 * YAML.stringify 的天性，这也是 /feedback 那两个按钮坚持不碰这个文件的原因。
 */
export function writePreference(dir, obj) {
  const target = prefFile(dir)
  let header = FILE_HEADER
  try {
    const first = fs.readFileSync(target, 'utf8').split(/\r?\n/, 1)[0]
    if (first.startsWith('#')) header = `${first}\n`
  } catch { /* 没有现文件就带模板头 */ }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `${FILE}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
  try {
    fs.writeFileSync(tmp, header + YAML.stringify(obj), 'utf8')
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* tmp 没建成就没得删 */ }
    throw e
  }
  return target
}

/**
 * PUT 的读半：原文解析，不 merge 默认、不合并 tuning.json。
 * loadPreference 在坏文件上会退默认——拿它当写盘的底稿，一次 PUT 就把用户的
 * 坏文件抹成默认了。这里宁可带着 errors 拒绝写（与归零路由同一条裁定）。
 */
export function readPreferenceRaw(dir) {
  const target = prefFile(dir)
  if (!fs.existsSync(target)) return { obj: {}, errors: [] }
  let parsed
  try {
    parsed = YAML.parse(fs.readFileSync(target, 'utf8'))
  } catch (e) {
    return { obj: null, errors: [`preference.yaml 解析失败: ${e.message}`] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { obj: null, errors: ['preference.yaml 不是一个映射'] }
  }
  return { obj: parsed, errors: [] }
}

/**
 * tuning 一键归零（设置页）。同样基于原文而不是 loadPreference：后者在校验不过的
 * 文件上退默认，归零路由照它写盘等于顺手抹掉用户的其余配置。
 * 只动 tuning 键；yaml 之外还要清 tuning.json——加载合并里 json 赢，不清它归零就还魂。
 * 解析不了就抛（路由翻成 400，一个字不写）。返回归零前在册的 delta 条数，给日志用。
 */
export function clearTuningFile(dir) {
  const raw = readPreferenceRaw(dir)
  if (raw.errors.length) throw new Error(raw.errors[0])
  const before = { ...readTuning(dir) }
  const yamlDelta = raw.obj.tuning?.source_delta
  if (yamlDelta && typeof yamlDelta === 'object' && !Array.isArray(yamlDelta)) {
    for (const [k, v] of Object.entries(yamlDelta)) if (Number.isFinite(v)) before[k] = v
  }
  raw.obj.tuning = { source_delta: {} }
  writePreference(dir, raw.obj)
  if (fs.existsSync(tuningFile(dir))) fs.writeFileSync(tuningFile(dir), '{}\n', 'utf8')
  return Object.keys(before).length
}

/**
 * 读偏好。**校验不过就退回默认并带 errors**，调用方（scheduler / 路由）据此拒绝起新一轮，
 * 绝不返回"半份用户配置"——半成品会让后面的抓取按错误主题跑，浪费的是用户的钱。
 */
export function loadPreference(dir = homeDir()) {
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    const pref = structuredClone(DEFAULTS)
    const t = readTuning(dir)
    if (Object.keys(t).length) pref.tuning.source_delta = t
    return { pref, errors: [], source: 'defaults', missing: true }
  }
  let parsed
  try {
    parsed = YAML.parse(fs.readFileSync(target, 'utf8'))
  } catch (e) {
    return { pref: structuredClone(DEFAULTS), errors: [`preference.yaml 解析失败: ${e.message}`], source: 'defaults' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { pref: structuredClone(DEFAULTS), errors: ['preference.yaml 不是一个映射'], source: 'defaults' }
  }
  const errors = validate(parsed)
  if (errors.length) {
    return { pref: structuredClone(DEFAULTS), errors, source: 'defaults' }
  }
  const pref = mergeDefaults(DEFAULTS, parsed)
  const t = readTuning(dir)
  if (Object.keys(t).length) {
    pref.tuning = { ...pref.tuning, source_delta: { ...(pref.tuning?.source_delta ?? {}), ...t } }
  }
  return { pref, errors: [], source: 'file' }
}

export function validate(obj) {
  const errs = []
  const isArr = Array.isArray
  const str = v => typeof v === 'string'
  const finite = Number.isFinite

  if (obj.version !== undefined && !finite(obj.version)) errs.push('version: 必须是数字')

  if (obj.themes !== undefined) {
    if (!isArr(obj.themes)) errs.push('themes: 必须是数组')
    else obj.themes.forEach((t, i) => {
      if (!t || typeof t !== 'object') { errs.push(`themes[${i}]: 必须是对象`); return }
      if (!str(t.group) || !t.group.trim()) errs.push(`themes[${i}].group: 必填字符串`)
      for (const k of ['must', 'any', 'never']) {
        if (t[k] !== undefined && (!isArr(t[k]) || t[k].some(s => !str(s)))) errs.push(`themes[${i}].${k}: 必须是字符串数组`)
      }
      if (t.weight !== undefined && !(finite(t.weight) && t.weight >= 0 && t.weight <= 2)) errs.push(`themes[${i}].weight: 0–2`)
    })
  }

  if (obj.follow !== undefined) {
    if (!obj.follow || typeof obj.follow !== 'object' || isArr(obj.follow)) errs.push('follow: 必须是映射')
    else if (obj.follow.feeds !== undefined && (!isArr(obj.follow.feeds) || obj.follow.feeds.some(s => !str(s)))) {
      errs.push('follow.feeds: 必须是字符串数组')
    }
  }

  const seen = new Set()
  if (obj.sources !== undefined) {
    if (!isArr(obj.sources)) errs.push('sources: 必须是数组')
    else obj.sources.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errs.push(`sources[${i}]: 必须是对象`); return }
      if (!str(s.id) || !s.id.trim()) { errs.push(`sources[${i}].id: 必填字符串`); return }
      if (seen.has(s.id)) errs.push(`sources[${i}].id: 与前面的源重复 "${s.id}"`)
      seen.add(s.id)
      if (!KNOWN_TYPES.includes(s.type)) errs.push(`sources[${i}].type: 本版本只支持 ${KNOWN_TYPES.join('/')}`)
      if (s.type === 'rss' && (!str(s.url) || !/^https?:\/\//i.test(s.url))) errs.push(`sources[${i}].url: rss 源必须是 http(s) URL`)
      if (s.type === 'bili' && (!str(s.url) || !s.url.trim())) errs.push(`sources[${i}].url: bili 源要填 UP 主 space URL（space.bilibili.com/<uid>）`)
      if (s.type === 'yt' && (!str(s.url) || !/^https?:\/\//i.test(s.url))) errs.push(`sources[${i}].url: yt 源必须是 http(s) URL（频道 /videos、playlist 或单视频）`)
      if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errs.push(`sources[${i}].enabled: 必须是布尔`)
      if (s.interval_min !== undefined && !(Number.isInteger(s.interval_min) && s.interval_min >= 15)) errs.push(`sources[${i}].interval_min: ≥15 的整数`)
      if (s.weight !== undefined && !(finite(s.weight) && s.weight >= 0 && s.weight <= 2)) errs.push(`sources[${i}].weight: 0–2`)
      if (s.max_age_days !== undefined && !(Number.isInteger(s.max_age_days) && s.max_age_days >= 1)) errs.push(`sources[${i}].max_age_days: ≥1 的整数（省略则用全局 limits.max_age_days）`)
    })
  }

  if (obj.schedule?.windows !== undefined) {
    if (!isArr(obj.schedule.windows)) errs.push('schedule.windows: 必须是数组')
    else obj.schedule.windows.forEach((w, i) => {
      if (!str(w) || !WINDOW_RE.test(w)) errs.push(`schedule.windows[${i}]: 要写成 "07:00-09:00"`)
    })
  }
  for (const k of ['max_per_run', 'max_per_day']) {
    const v = obj.schedule?.[k]
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) errs.push(`schedule.${k}: 正整数`)
  }
  if (obj.schedule?.off_peak_only !== undefined && typeof obj.schedule.off_peak_only !== 'boolean') {
    errs.push('schedule.off_peak_only: 必须是布尔')
  }

  if (obj.limits?.max_age_days !== undefined && !(Number.isInteger(obj.limits.max_age_days) && obj.limits.max_age_days >= 0)) {
    errs.push('limits.max_age_days: 非负整数')
  }
  if (obj.limits?.min_duration_sec !== undefined && !(Number.isInteger(obj.limits.min_duration_sec) && obj.limits.min_duration_sec >= 0)) {
    errs.push('limits.min_duration_sec: 非负整数')
  }
  if (obj.limits?.skip_kinds !== undefined && (!isArr(obj.limits.skip_kinds) || obj.limits.skip_kinds.some(s => !['video', 'article', 'note'].includes(s)))) {
    errs.push('limits.skip_kinds: 只能是 video/article/note')
  }

  if (obj.yt_dlp_path !== undefined && !str(obj.yt_dlp_path)) errs.push('yt_dlp_path: 必须是字符串（yt-dlp 可执行名或绝对路径，缺省 yt-dlp 走 PATH）')
  if (obj.network !== undefined) {
    if (!obj.network || typeof obj.network !== 'object' || isArr(obj.network)) errs.push('network: 必须是映射')
    else if (obj.network.proxy !== undefined && !str(obj.network.proxy)) errs.push('network.proxy: 必须是字符串（空 = 不走代理；只传给 yt-dlp 的 --proxy，不动全局 fetch）')
  }

  if (obj.require_theme_hit !== undefined && typeof obj.require_theme_hit !== 'boolean') {
    errs.push('require_theme_hit: 必须是布尔')
  }
  if (obj.inject_prompt !== undefined && typeof obj.inject_prompt !== 'boolean') {
    errs.push('inject_prompt: 必须是布尔')
  }
  if (obj.redlines !== undefined && (!isArr(obj.redlines) || obj.redlines.some(s => !str(s)))) errs.push('redlines: 必须是字符串数组')

  if (obj.tuning?.source_delta !== undefined) {
    const sd = obj.tuning.source_delta
    if (!sd || typeof sd !== 'object' || isArr(sd)) errs.push('tuning.source_delta: 必须是映射')
    else for (const [k, v] of Object.entries(sd)) {
      if (!finite(v) || Math.abs(v) > CLAMP) errs.push(`tuning.source_delta.${k}: 限幅 ±${CLAMP}`)
    }
  }

  if (obj.charter !== undefined && !str(obj.charter)) errs.push('charter: 必须是字符串')

  return errs
}

/** 面板两个按钮的唯一入口：只动 tuning，其他字段原样带走。 */
export function bumpTuning(pref, sourceId, delta) {
  const next = structuredClone(pref)
  next.tuning = next.tuning && typeof next.tuning === 'object' ? next.tuning : {}
  next.tuning.source_delta = next.tuning.source_delta && typeof next.tuning.source_delta === 'object' ? next.tuning.source_delta : {}
  const cur = Number(next.tuning.source_delta[sourceId]) || 0
  next.tuning.source_delta[sourceId] = Math.max(-CLAMP, Math.min(CLAMP, Math.round((cur + delta) * 100) / 100))
  return next
}

function mergeDefaults(base, over) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDefaults(base[k], v)
    } else if (v !== undefined) {
      out[k] = structuredClone(v)
    }
  }
  return out
}
