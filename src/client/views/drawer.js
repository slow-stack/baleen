/**
 * 条目抽屉：这条"为什么给你"的落点，也是唯一会改偏好的交互面。
 *
 * 两个按钮的语义必须写在界面上：**只动来源权重（tuning），不动主题词（themes）**。
 * 结果一定要回显——点了不知道有没有记上，等于把偏好系统的黑盒交给了用户。
 */
import { vnode } from '../vnode.js'
import { matchInfo } from '../match.js'
import { fmtDuration, readbackMiss, foldersUnreadNote, httpUrl } from '../format.js'
import { readerParagraphs } from './article.js'

const DELTA = { dismiss: '-0.1', save: '+0.1' }
/** 每种 body_state 一句说法：正文区与能力边界共用，别两处各写一遍再各自漂移 */
const STATE_NOTE = {
  full: '',
  summary_only: '只有摘要：这个源只给摘要，全文在原文里——不是我们读不到。',
  subtitle: '字幕全文已存，正文区就是字幕。',
  transcribed: '这段来自本地转写。',
  missing: '没有语音也没有字幕轨，读不到内容。',
  burned_in: '硬字幕：字烧在画面上，读不到内容。'
}
/** 这三种是"能力边界"，其余只是内容来源说明 */
const LIMITS = new Set(['summary_only', 'missing', 'burned_in'])

export function feedbackHint(action) {
  return action === 'dismiss'
    ? '不感兴趣：只改来源权重（-0.1，累计限幅 ±0.5），不改你的主题词'
    : '这源多来点：只改来源权重（+0.1，累计限幅 ±0.5），不改你的主题词'
}

/**
 * 能不能播（按源）与能不能读（按 body_state）是两件事，各自说一句。
 * 早先只回一句的话，B 站硬字幕条目会被播放器的说法盖掉，看不出内容其实读不到。
 * 播放器 M4a 没做（V5 先探后定），所以这里不许预告任何接入时间——跳转就是现状。
 */
/**
 * 内嵌播放器（V5 真机实证 2026-11-01：面板页 iframe 不被宿主 CSP 拦）。
 * B 站=完整页 iframe（bilibili 试图跳出顶层会被 Chromium 自动拦，实测无害；
 * 官方 player.html 反而是空壳）；YouTube=官方 embed，带 rel=0——播完不出
 * 相关视频网格，跟"不让你顺着推荐刷下去"是同一条产品意图。作者关了嵌入的
 * 视频会显示 YouTube 自己的提示，此时走「浏览器打开」。其余平台返回 null。
 */
export function playerEmbed(url) {
  const s = String(url ?? '')
  const bili = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/.exec(s)
  if (bili) return { kind: 'bili', src: 'https://www.bilibili.com/video/' + bili[1] }
  const yt = /[?&]v=([0-9A-Za-z_-]{11})/.exec(s) || /youtu\.be\/([0-9A-Za-z_-]{11})/.exec(s)
  if (yt && /youtube\.com|youtu\.be/.test(s)) return { kind: 'youtube', src: 'https://www.youtube.com/embed/' + yt[1] + '?rel=0' }
  return null
}

/**
 * 播放器舞台：抽屉与侧栏 tab 共用这一份标记、同一套 .bl-stage* 样式。
 * 裁切窗跟着容器宽度走（aspect-ratio 16:9 = 视频面本来的形状），不再是写死的
 * 像素对——窄容器漏推荐流、宽容器把 B 站控制条（音量在那）裁出窗外，都是固定值惹的。
 * B 站是完整页，多带一个 bl-stage-bili 让 CSS 做版心缩放 + 页头偏移（css.js 的
 * --bl-frame/--bl-nav）；YouTube embed 本来就是纯 16:9 播放器，精确合围即止。
 * 裁切模式给 iframe 加 scrolling=no：内页滚不动，推荐流连滚出来的机会都没有；
 * 还原模式（crop=false）保留滚动——那本来就是"看完整页"的路。
 * 音量/倍速这些控件在跨源 iframe 里面，我们够不着，也不打算假装够得着——界面上明说用原播放器的。
 */
export function playerStage(embed, crop) {
  const cls = ['bl-stage']
  if (crop) cls.push('bl-stage-crop')
  if (crop && embed.kind === 'bili') cls.push('bl-stage-bili')
  return vnode('div', { className: cls.join(' ') }, [
    vnode('iframe', {
      className: 'bl-player',
      src: embed.src,
      title: '视频播放器',
      allow: 'autoplay; fullscreen',
      allowfullscreen: true,
      scrolling: crop ? 'no' : 'auto'
    })
  ])
}

export function boundaryNote(item) {
  const bits = []
  if (item?.kind === 'video') {
    bits.push(playerEmbed(item?.url)
      ? '内嵌播放器在上方，直接看；弹幕和评论区要去原站。'
      : item.source_id === 'bili'
        ? '这个视频的地址解析不出嵌入形态，只能跳到浏览器里看。'
        : '这个平台没有可靠的嵌入方案，只能跳到浏览器里看。')
  }
  if (LIMITS.has(item?.body_state)) bits.push(STATE_NOTE[item.body_state])
  return bits.join(' ')
}

const kindLabel = (kind) => (kind === 'video' ? '视频' : kind === 'note' ? '图文笔记' : '文章')

function Section({ title, children }) {
  return vnode('section', {}, [vnode('h5', {}, [title]), ...children.filter(Boolean)])
}

/**
 * 勾上/取消某个夹之后该提交的集合。规矩是"原有在前、新勾追加"：
 * 不按夹列表的顺序反推——那个顺序是面板右侧的展示顺序，不是这条的归属历史；
 * 条目上已有的、夹列表里认不出的 id 一律原样留着——那多半是"这一秒刚被另一格删掉"，
 * 静默丢弃等于替用户做了他没做的决定。
 * folders 参数暂不参与排序，留着是为了签名与夹列表同源（调用方不必自己先换算）。
 */
export function collectSetOf(item, folders, toggleId, on) {
  const cur = Array.isArray(item?.folders) ? item.folders.filter((x) => Number.isInteger(x)) : []
  void folders
  return on ? [...new Set([...cur, toggleId])] : cur.filter((x) => x !== toggleId)
}

/**
 * 装配层的"过期归属"覆盖：抽屉里那条来自不带 folders 字段的查询时（今天的三格），
 * /collect 成功读回的归属按条目 id 覆盖回抽屉这一条——只改抽屉的展示，不动列表真相。
 * 没有这层，连点两个勾各自从"没读到"算起，第二次全量替换会把第一次的放进整个抹掉。
 * 只在 found 存在、自身没有 folders、knownFolders 指的是同一条时才覆盖，其余原样返回。
 */
export function drawerItemWithFolders(found, knownFolders) {
  return found && !Array.isArray(found.folders) && knownFolders && knownFolders.itemId === found.id
    ? { ...found, folders: knownFolders.folder_ids }
    : found
}

/** 夹 id 说回人能认的名字；列表里查不到就明写"这个夹已经没了"，不编一个 */
const namesOf = (item, folders, ids) => (ids ?? []).map((id) =>
  (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`).join(' / ') || '（现在不在任何夹里）'

export function Drawer({ item, api = {}, onClose, onDone, note, folders = [], collecting = false, newFolderName = '', onNewFolderName = () => {}, onOpenUrl, sidebar = null }) {
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

  async function toggleCollect(folderId, on) {
    return submit(collectSetOf(item, folders, folderId, on))
  }

  /**
   * 收藏的提交：/collect 是全量替换，回显必须来自服务端读回（或明说读不到）。
   * 三分支都要走到话：成功、folder_gone（带是哪几个）、其它失败——点了没反应
   * 等于把偏好系统的黑盒交给用户。res 形状不保证带 stale，一律按 ok/error 分支。
   */
  async function submit(folderIds, newFolder) {
    let res = null
    try {
      res = await api.collect?.(item?.id, folderIds, newFolder)
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) }
    }
    // data 可能是 null（2xx 但 body 没读出来）：名字与归属都用"能读回什么"分支，读不到就回退到发出去的意图。
    const readFolders = res && res.ok && Array.isArray(res.data?.folders) ? res.data.folders : null
    const readIds = res && res.ok && Array.isArray(res.data?.folder_ids) ? res.data.folder_ids : null
    const known = readFolders ?? folders
    const after = res && res.ok ? (readIds ?? folderIds) : null
    // 应答里既没带归属也没带夹表时不许光说"已放进"：那是没读回来，不是读到了（话术与收藏页同一句）。
    const unreadTail = after && readIds === null && readFolders === null ? `（${readbackMiss('服务端确认的归属')}，这句是按你勾的说的）` : ''
    const message = after
      ? `已放进：${namesOf(item, known, after)}${unreadTail}`
      : res && res.error === 'folder_gone'
        ? `没记上：${res.missing?.length ? `夹 ${res.missing.join('、')} 已经不在了` : `有夹已经不在了，但${readbackMiss('是哪几个')}`}，重新勾一次`
        : res && res.error === 'name_taken'
          // 新建重名夹是用户真会踩到的失败（终审 D1）：说人话，别把英文短码直出给用户。
          // 与收藏页 runFolder 的映射逐字一致；bad_name/name_too_long 在抽屉不可达
          // （空串不发请求、maxLength=40 挡输入），不用映射。
          ? '已经有这个夹了'
          : `没记上（${(res && res.error) || '宿主接口没应答'}）`
    onDone?.({ message, kind: 'collect', folderIds: after ?? undefined, folders: readFolders ?? undefined })
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
  const paras = readerParagraphs(body)
  const hasFolders = (folders ?? []).length > 0
  const link = httpUrl(item.url)
  const embed = playerEmbed(item.url)

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
        item.verdict_tier ? `已判：${item.verdict_tier}` : '待判',
        // 时长只对视频有意义，且坏值（0/非数字）不给徽章留个"时长"空壳——fmtDuration 返回空串就整段不画
        item.kind === 'video' && fmtDuration(item.duration_sec) ? `时长 ${fmtDuration(item.duration_sec)}` : null
      ].filter(Boolean)),
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
          // 正文与阅读器同一条分段规则（readerParagraphs）：空行成段、单换行保留，
          // 字幕在抽屉里也逐行可读；排版类 bl-reader-body 与文章页同一份。
          vnode('div', { className: 'bl-reader-body' },
            paras.length ? paras.map((p, i) => vnode('p', { key: i }, [p])) : ['（没有可读内容）']),
          STATE_NOTE[item.body_state] ? vnode('p', { className: 'bl-reader-hint' }, [STATE_NOTE[item.body_state]]) : null
        ]
      }),
      item.verdict_why ? Section({ title: '会话的判断', children: [vnode('p', {}, [`为什么判成「${item.verdict_tier}」：${item.verdict_why}`])] }) : null,
      // 内嵌播放（V5 实证可行）：视频且能解析出嵌入形态就直接在抽屉里放，
      // 不把人跳去平台——须鲸的初衷是"在你待着的地方看"。舞台用与侧栏 tab 同一份
      // playerStage()：完整页 iframe 往下会带出平台的推荐流，裁掉是产品意图。
      embed ? Section({
        title: '内嵌播放',
        children: [
          playerStage(embed, true),
          vnode('p', { className: 'bl-note' }, ['只露播放器本体，推荐流被裁掉是不想让你刷下去；音量、倍速用画面里的原播放器控件。'])
        ]
      }) : null,
      boundaryNote(item) ? Section({ title: '能力边界', children: [vnode('p', {}, [boundaryNote(item)])] }) : null,
      Section({
        title: '收藏到…',
        children: [
          hasFolders ? null : vnode('p', { className: 'bl-missing' }, [`${foldersUnreadNote}，这次没法收藏。`]),
          // 这条 item 可能来自不带 folders 字段的查询（今天的三格）：那是"没读到"，不是"在 0 个夹里"，
          // 明说全量替换的后果，让用户知道自己勾的会被当成全部归属。
          Array.isArray(item.folders) ? null : vnode('p', { className: 'bl-note' }, ['这条当前在哪些夹里还没读到；下面以空勾起步，放进会把你勾的当成它的全部归属。']),
          hasFolders ? vnode('div', { className: 'bl-collect' }, folders.flatMap((f) => [
            vnode('input', {
              key: `cb-${f.id}`,
              type: 'checkbox',
              id: `baleen-cb-${item.id}-${f.id}`,
              'aria-label': '放进：' + f.name,
              checked: (item.folders ?? []).includes(f.id),
              disabled: Boolean(collecting),
              onChange: (e) => toggleCollect(f.id, Boolean(e?.target?.checked))
            }),
            vnode('label', { key: `lb-${f.id}`, htmlFor: `baleen-cb-${item.id}-${f.id}` }, [f.name + (f.is_default ? '（默认）' : '')])
          ])) : null,
          vnode('div', { className: 'bl-newfolder' }, [
            vnode('input', { type: 'text', 'aria-label': '新夹名', placeholder: '起个名，1-40 字', maxLength: 40, value: newFolderName, onChange: (e) => onNewFolderName?.(e?.target?.value ?? '') }),
            vnode('button', {
              type: 'button',
              disabled: Boolean(collecting),
              onClick: () => ((newFolderName ?? '').trim()
                ? submit([...(item.folders ?? [])], (newFolderName || '').trim())
                : undefined)
            }, ['新建夹并放入'])
          ])
        ]
      }),
      // 原文地址：真的 <a href>。早先这里是 <p>，那句话"跳到浏览器里看"等于空头支票。
      // 地址不是 http/https 就整段不画——不拿一个点不动的假链接充数。
      // （2026-10-31 真机验收：本宿主把客户端页面的弹窗与外链全部静默拦下，<a> 与
      // window.open 都到不了系统浏览器——「浏览器打开」改走宿主侧 /open 路由，面板
      // 只报条目 id、URL 由宿主从库里取。
      // 「侧栏播放」在 0.30.1 语义下回归：面板在前台时 openTab 进 pending 队列，
      // 会话回到前台由 better-sidebar 的 flushPending 落进右侧栏——不是死按钮，
      // 是异步开；前提是排队语义写在按钮提示与回显里，不让人点了没反应。）
      link ? Section({
        title: '原文',
        children: [
          vnode('p', {}, [vnode('a', { className: 'bl-url', href: link, target: '_blank', rel: 'noopener noreferrer' }, [link])]),
          vnode('div', { className: 'bl-openbtns' }, [
            vnode('button', { type: 'button', onClick: () => onOpenUrl?.(link, item.id) }, ['浏览器打开']),
            item.kind === 'video' && embed && sidebar?.available
              ? vnode('button', {
                  type: 'button',
                  title: '在侧栏里播这条，不去平台。面板在前台时它会先排队，切回会话页签自动出现',
                  onClick: () => {
                    if (sidebar.open(item.url, item.title)) {
                      onDone?.({ message: '已请求侧栏播放——右侧栏没立刻出现的话，切回会话页签它会自动开。' })
                    } else {
                      onDone?.({ message: '侧栏没接住这条——先在抽屉里播，或者去浏览器打开。' })
                    }
                  }
                }, ['侧栏播放'])
              : null
          ].filter(Boolean)),
          vnode('p', { className: 'bl-note' }, [embed
            ? '侧栏要是有会话在前台就当场开，否则先排队——切回会话页签它自动出现。'
            : '这条解析不出嵌入形态，侧栏也播不了；要去系统浏览器就用上面的按钮。'])
        ]
      }) : null,
      vnode('p', { className: 'bl-note' }, ['下面两个按钮只调来源权重，不改你的主题词；当前偏移在设置页能看到也能一键归零。'])
    ]),
    note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
    vnode('footer', { className: 'bl-dbtns' }, [
      vnode('button', { type: 'button', title: feedbackHint('dismiss'), onClick: () => fire('dismiss') }, ['不感兴趣']),
      vnode('button', { type: 'button', className: 'bl-save', title: feedbackHint('save'), onClick: () => fire('save') }, ['这源多来点'])
    ])
  ])
}
