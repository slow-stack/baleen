/**
 * 「今天」= 门户头版。这一屏承担全部的诚实责任：
 * 过筛多少、候选多少、待判多少、为什么被丢、哪个源挂了，都得看得见。
 * 纯函数：数据从参数进，不读 window、不发请求。
 */
const GAP_LABELS = {
  'theme-reject': '命中排除词',
  'no-body': '读不到内容',
  stale: '超龄',
  'too-short': '时长过短',
  'skip-kind': '形态被跳过',
  'below-score': '得分不够',
  'no-match': '没命中主题'
}
const FLAG_LABELS = { burned_in: '硬字幕读不到', missing: '无语音' }

export const REASONS_READABLE = GAP_LABELS

const n = (v) => Number(v) || 0
import { vnode } from '../vnode.js'
import { reasonOf } from '../match.js'
import { fmtDuration, judgeHint } from '../format.js'

/** 一轮的结局 → 面板上的说法。'interrupted' 是进程被打断，不是抓取失败，得单独说。 */
export const RUN_LABELS = {
  done: '跑完',
  partial: '部分源失败',
  failed: '失败',
  interrupted: '被打断',
  running: '在跑',
}

export function summaryLine(state) {
  const c = state?.counts ?? {}
  const run = state?.last_run
  const head = run
    ? `上一轮 ${RUN_LABELS[run.status] ?? '失败'} · 过筛 ${n(c.total)} → 候选 ${n(run.candidates)} → 待判 ${n(c.new)}`
    : `库里 ${n(c.total)} 条 · 还没有跑过一轮`
  return `${head}｜已判 ${n(c.judged) + n(c.digest)}`
}

export function gapText(gaps) {
  // gaps 缺席（state 里没有这轮的记录）才说"还没有"；跑过轮但零丢弃零豁免时诚实显示"丢弃 0"——
  // M3 真机验收见过：定时空配置一轮抓 0 条，旧文案把"跑过但空"谎报成"还没有一轮记录"。
  if (gaps == null || typeof gaps !== 'object') return '（还没有一轮记录）'
  const by = gaps.by_reason ?? {}
  const kept = Object.entries(gaps.kept_with_flag ?? {})
  const held = n(gaps.held)
  // 收藏钉住（D15）：豁免的丢弃没发生，不进 by_reason，单独一枚 chip，大于零才显示。
  return [`丢弃 ${n(gaps.total_dropped)}`, ...Object.entries(by).map(([k, v]) => `${GAP_LABELS[k] ?? k} ${v}`),
    ...(kept.length ? [`保留待读：${kept.map(([k, v]) => `${FLAG_LABELS[k] ?? k} ${v}`).join(' / ')}`] : []),
    ...(held ? [`收藏钉住 ${held}`] : [])].join(' · ')
}

function sourceIssues(state) {
  return (state?.sources ?? []).filter((s) => s.ok === false).map((s) => ({
    id: s.id,
    text: s.error_class === 'needs_login' ? `${s.id} 需要重新登录`
      : s.error_class === 'unavailable' ? `${s.id} 缺依赖，去设置页装`
        : s.error_class === 'empty' ? `${s.id} 本轮取到 0 条`
          : `${s.id} 本轮失败（${s.error_class ?? '未知'}），游标没推进，下轮自动补`
  }))
}

function Card({ item, onOpen }) {
  return vnode('button', { type: 'button', className: 'bl-card', onClick: () => onOpen?.(item.id) }, [
    item.kind === 'video' ? vnode('span', { className: 'bl-thumb' }, [vnode('span', { className: 'bl-dur' }, [fmtDuration(item.duration_sec) || '—'])]) : null,
    vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
    vnode('span', { className: 'bl-card-meta' }, [item.source_id, item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章']),
    vnode('span', { className: 'bl-tier' }, [item.verdict_tier ? `已判：${item.verdict_tier}` : '待判']),
    vnode('span', { className: 'bl-why' }, [reasonOf(item)])
  ].filter(Boolean))
}

export function TodayView({ state, items = [], onPickView, onOpen, onRun, busy }) {
  const videos = items.filter((i) => i.kind === 'video')
  const writings = items.filter((i) => i.kind !== 'video')
  const pending = n(state?.counts?.new)
  const issues = sourceIssues(state)

  return vnode('div', { className: 'bl-today' }, [
    vnode('div', { className: 'bl-summary' }, [summaryLine(state)]),
    vnode('div', { className: 'bl-gaps' }, [gapText(state?.gaps)]),
    issues.length ? vnode('div', { className: 'bl-issues', role: 'status' }, issues.map((s) => s.text)) : null,
    vnode('div', { className: 'bl-pending' }, [
      pending
        ? `待判 ${pending} 条——判断由会话来做，${judgeHint}就行`
        : '没有待判条目'
    ]),
    vnode('div', { className: 'bl-actions' }, [
      vnode('button', { type: 'button', disabled: Boolean(busy), onClick: () => onRun?.() }, [busy ? '跑着…' : '现在跑一轮']),
      vnode('button', { type: 'button', onClick: () => onPickView?.('library') }, ['去库'])
    ]),
    vnode('section', { className: 'bl-rail' }, [
      vnode('h3', {}, [`视频区 · ${videos.length}`]),
      videos.length ? vnode('div', { className: 'bl-grid' }, videos.map((it) => Card({ item: it, onOpen })))
        : vnode('p', { className: 'bl-empty' }, ['这个库里还没有视频。B 站 / 小红书视频笔记在 M4 接入。'])
    ]),
    vnode('section', { className: 'bl-rail' }, [
      vnode('h3', {}, [`文章区 · ${writings.length}`]),
      writings.length ? vnode('div', { className: 'bl-grid' }, writings.map((it) => Card({ item: it, onOpen })))
        : vnode('p', { className: 'bl-empty' }, ['文章区是空的。可能是刚清过库，或者筛选把东西都丢了。'])
    ])
  ].filter(Boolean))
}
