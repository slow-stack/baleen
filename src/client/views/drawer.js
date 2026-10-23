/**
 * 条目抽屉：这条"为什么给你"的落点，也是唯一会改偏好的交互面。
 *
 * 两个按钮的语义必须写在界面上：**只动来源权重（tuning），不动主题词（themes）**。
 * 结果一定要回显——点了不知道有没有记上，等于把偏好系统的黑盒交给了用户。
 */
import { vnode } from '../vnode.js'
import { matchInfo } from '../match.js'

const DELTA = { dismiss: '-0.1', save: '+0.1' }
/** 每种 body_state 一句说法：正文区与能力边界共用，别两处各写一遍再各自漂移 */
const STATE_NOTE = {
  full: '',
  summary_only: '只有摘要：这个源只给摘要，全文在原文里——不是我们读不到。',
  subtitle: '这段来自字幕。',
  transcribed: '这段来自本地转写。',
  missing: '没有语音也没有字幕轨，读不到内容。',
  burned_in: '硬字幕：字烧在画面上，读不到内容。'
}
/** 这三种是"能力边界"，其余只是内容来源说明 */
const LIMITS = new Set(['summary_only', 'missing', 'burned_in'])

export function feedbackHint(action) {
  return action === 'dismiss'
    ? '不感兴趣：只改来源权重（-0.1，累计限幅 ±0.5），不改你的主题词'
    : '收藏：只改来源权重（+0.1，累计限幅 ±0.5），不改你的主题词'
}

/**
 * 能不能播（按源）与能不能读（按 body_state）是两件事，各自说一句。
 * 早先只回一句的话，B 站硬字幕条目会被播放器的说法盖掉，看不出内容其实读不到。
 * M2 还没有播放器，所以这里不许提前许诺。
 */
export function boundaryNote(item) {
  const bits = []
  if (item?.kind === 'video') {
    bits.push(item.source_id === 'bili'
      ? 'B 站：抽屉内嵌播放器在 M4 接入，现在只能跳到浏览器里看。'
      : '这个平台没有可靠的嵌入方案，只能跳到浏览器里看。')
  }
  if (LIMITS.has(item?.body_state)) bits.push(STATE_NOTE[item.body_state])
  return bits.join(' ')
}

const kindLabel = (kind) => (kind === 'video' ? '视频' : kind === 'note' ? '图文笔记' : '文章')

function Section({ title, children }) {
  return vnode('section', {}, [vnode('h5', {}, [title]), ...children.filter(Boolean)])
}

export function Drawer({ item, api = {}, onClose, onDone, note }) {
  async function fire(action) {
    let res = null
    try {
      res = await api.feedback?.(item?.source_id, action)
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) }
    }
    const message = res && res.ok
      ? `${item.source_id} 权重 ${DELTA[action]}——只改 tuning，你的 themes 一个字没动`
      : `没记上（${(res && res.error) || '宿主接口没应答'}）`
    onDone?.({ message, action })
    return message
  }

  if (!item) {
    return vnode('aside', { className: 'bl-drawer bl-empty-state', role: 'dialog', 'aria-label': '条目详情' }, [
      vnode('p', {}, ['这条不在当前列表里（可能已被新的一对替换，或在归档的那批里）。关掉这格，去「库」里按状态找。']),
      vnode('button', { type: 'button', onClick: () => onClose?.() }, ['关闭'])
    ])
  }

  const m = matchInfo(item)
  const body = typeof item.body_text === 'string' ? item.body_text.trim() : ''

  return vnode('aside', { className: 'bl-drawer', role: 'dialog', 'aria-label': '条目详情' }, [
    vnode('header', { className: 'bl-dbar' }, [
      vnode('span', { className: 'bl-badge' }, [item.source_id || '（没来源）']),
      vnode('span', { className: 'bl-dtitle' }, [item.title || '（无标题）']),
      vnode('button', { type: 'button', onClick: () => onClose?.() }, ['关闭'])
    ]),
    vnode('div', { className: 'bl-dmain' }, [
      vnode('div', { className: 'bl-kv' }, [
        item.author || '未知作者',
        kindLabel(item.kind),
        item.verdict_tier ? `已判：${item.verdict_tier}` : '待判'
      ]),
      Section({
        title: '为什么给你',
        children: [
          vnode('p', { className: m.text ? '' : 'bl-missing' }, [m.text || '（这条没写理由）']),
          m.keywords.length
            ? vnode('p', { className: 'bl-kw' }, ['命中词：' + m.keywords.join('、') + (m.groups.length ? `（${m.groups.join('、')}）` : '')])
            : null
        ]
      }),
      Section({
        title: item.kind === 'video' ? '字幕原文' : '正文',
        children: [
          vnode('p', {}, [body || '（没有可读内容）']),
          STATE_NOTE[item.body_state] ? vnode('p', { className: 'bl-reader-hint' }, [STATE_NOTE[item.body_state]]) : null
        ]
      }),
      item.verdict_why ? Section({ title: '会话的判断', children: [vnode('p', {}, [`为什么判成「${item.verdict_tier}」：${item.verdict_why}`])] }) : null,
      boundaryNote(item) ? Section({ title: '能力边界', children: [vnode('p', {}, [boundaryNote(item)])] }) : null,
      item.url ? Section({ title: '链接', children: [vnode('p', { className: 'bl-url' }, [item.url])] }) : null,
      vnode('p', { className: 'bl-note' }, ['下面两个按钮只调来源权重，不改你的主题词；当前偏移在设置页（M5）能看到也能一键归零。'])
    ]),
    note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
    vnode('footer', { className: 'bl-dbtns' }, [
      vnode('button', { type: 'button', title: feedbackHint('dismiss'), onClick: () => fire('dismiss') }, ['不感兴趣']),
      vnode('button', { type: 'button', className: 'bl-save', title: feedbackHint('save'), onClick: () => fire('save') }, ['收藏'])
    ])
  ])
}
