import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { homeDir } from './paths.js'

const FILE = 'preference.yaml'
const CLAMP = 0.5
const KNOWN_TYPES = ['rss']          // bili / xhs / yt 由后续计划登记进来
const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

export const DEFAULTS = {
  version: 1,
  themes: [],
  follow: { feeds: [] },
  sources: [],
  schedule: { windows: ['07:00-09:00', '12:30-13:30'], off_peak_only: true, max_per_run: 25, max_per_day: 60 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  tuning: { source_delta: {} },
  redlines: ['广告代理', '引流私聊', '付费课程推销'],
  charter: ''
}

export function prefFile(dir = homeDir()) {
  return path.join(dir, FILE)
}

export function ensurePreferenceFile(dir = homeDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    const header = '# 改这里：themes / follow / sources 是你的，tuning 只由面板那两个按钮写。\n'
    fs.writeFileSync(target, header + YAML.stringify(DEFAULTS), 'utf8')
  }
  return target
}

/**
 * 读偏好。**校验不过就退回默认并带 errors**，调用方（scheduler / 路由）据此拒绝起新一轮，
 * 绝不返回"半份用户配置"——半成品会让后面的抓取按错误主题跑，浪费的是用户的钱。
 */
export function loadPreference(dir = homeDir()) {
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    return { pref: structuredClone(DEFAULTS), errors: [], source: 'defaults', missing: true }
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
  return { pref: mergeDefaults(DEFAULTS, parsed), errors: [], source: 'file' }
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
      if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errs.push(`sources[${i}].enabled: 必须是布尔`)
      if (s.interval_min !== undefined && !(Number.isInteger(s.interval_min) && s.interval_min >= 15)) errs.push(`sources[${i}].interval_min: ≥15 的整数`)
      if (s.weight !== undefined && !(finite(s.weight) && s.weight >= 0 && s.weight <= 2)) errs.push(`sources[${i}].weight: 0–2`)
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
