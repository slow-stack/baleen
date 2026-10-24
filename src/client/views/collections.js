/**
 * 「收藏」页：左列是夹，右区是这个夹里收过的条目。
 *
 * 三条诚实规矩：
 *  1. 已归档的条目照样列出并写明原因——"我收过的东西不会凭空消失"（spec D15）；
 *  2. 夹上的数字与点进去的条数同源（都来自 folder_items 的 COUNT，不筛状态），
 *     所以这里绝不再按 status 滤一遍，否则"写着 3 条点进去 2 条"；
 *  3. 一个夹都没读回来时不许假装：不画标签栏、不画卡片，也不说"你一条都还没收过"
 *     ——把读回失败说成"空的"是谎（话术与抽屉共用 format.js 里那一句）。
 *
 * 纯函数：不发请求、不读 window，产 {type, props, children}，由装配层经 toElement 桥给 React。
 */
import { vnode } from '../vnode.js'
import { fmtTime, foldersUnreadNote } from '../format.js'

/** 只给顺序，不改数据：默认夹永远第一，其余按 id（与服务端 listFolders 的次序同源）。 */
export const folderTabs = (folders) => (folders ?? []).slice()
  .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id - b.id)

/** 夹 id 说回人能认的名字；列表里查不到就明写"这个夹已经没了"，不编一个名字。 */
export const nameOf = (folders, id) =>
  (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`

/**
 * 这一屏看的是哪个夹：筛选里那个夹**在读回的列表里认得出**才算，否则落到默认夹（folderTabs 的第一个）。
 * "认不出就回落"不是敷衍：筛选里的 id 很可能是另一格刚删掉的夹，把已消失的夹当成当前夹会继续
 * 拿它去取数（恒空），页面就成了"这个夹还是空的"那种谎。
 * 一个夹都没读回来时返回 null —— 装配层据此连 folder 参数都不发，
 * 免得把"没筛夹"捞回来的一堆条目当成收藏关系画出来。
 */
export const currentFolderId = (folders, filters) => {
  const list = folders ?? []
  const wanted = Number(filters?.folder)
  if (wanted && list.some((f) => f.id === wanted)) return wanted
  return folderTabs(list)[0]?.id ?? null
}

function CollectedCard({ item, folders, cur, onOpen }) {
  // spec §6.2 卡面要的是"它还在哪些**别的**夹里"：item.folders 里含当前夹自己，
  // 不滤掉就会在单夹条目上写出"还在：默认"这种语病。滤完一个不剩时这行整个不出现——
  // 原文没规定空列表的说法，最不撒谎的做法是什么都不说。
  const alsoIn = (item.folders ?? []).filter((id) => id !== cur)
  return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
    vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
    vnode('span', { className: 'bl-card-meta' }, [
      item.source_id || '（没来源）',
      item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章',
      // 收进来的时间，不是发布时间：这页回答的是"我什么时候存的"
      '收进来：' + fmtTime(item.added_at)
    ]),
    item.status === 'archived'
      ? vnode('span', { className: 'bl-missing' }, [`已归档：${item.archived_reason || '原因没记'}（收藏不会让它重新出现在今天）`])
      : null,
    alsoIn.length
      ? vnode('span', { className: 'bl-in' }, ['还在：' + alsoIn.map((id) => nameOf(folders, id)).join(' / ')])
      : null
  ].filter(Boolean))
}

export function CollectionsView({
  items = [], folders = [], filters = {}, pendingDelete = null, note,
  newFolderName = '', currentName = '', onNewFolderNameChange = () => {}, onCurrentNameChange = () => {},
  onPickFolder, onCreate, onRename, onAskDelete, onCancelDelete, onDelete, onOpen
}) {
  const list = folders ?? []
  const tabs = folderTabs(list)
  const cur = currentFolderId(list, filters)
  // 当前夹就是 currentFolderId 认下来的那一个：与装配层取数用的是同一个 id，页面不会自相矛盾。
  const curFolder = list.find((y) => y.id === cur) ?? null
  const total = list.reduce((sum, f) => sum + (Number(f.count) || 0), 0)
  const unread = !list.length
  // 二次确认只跟着"当前正在看的那个夹"：pendingDelete 指向别的夹时不该拦住这一夹的工具条
  const confirming = pendingDelete != null && curFolder != null && pendingDelete === curFolder.id
  // 改名框：装配层给的草稿优先，没草稿就回填服务端读到的夹名（不是空框让人猜）
  const renameValue = currentName || curFolder?.name || ''

  const emptyText = unread
    ? `${foldersUnreadNote}。这一页列不出收藏关系，但你收过的条目一条都没少——回到「今天」再点一次收藏，或者刷新这格。`
    : total === 0
      ? '你一条都还没收过。在「今天」或「视频」里点开一条，抽屉下方有「收藏到…」。'
      : `这个夹还是空的（「${curFolder?.name ?? '当前夹'}」里一条都没有）。去别的页用抽屉「收藏到…」放进来。`

  return vnode('div', { className: 'bl-collections' }, [
    unread ? null : vnode('aside', { className: 'bl-folderlist', 'aria-label': '收藏夹' },
      tabs.map((f) => vnode('button', {
        type: 'button', key: f.id, className: 'bl-foldertab', 'data-folder': f.id,
        'aria-current': f.id === cur ? 'page' : 'false',
        onClick: () => onPickFolder?.(f.id)
      }, [`${f.name}${f.is_default ? '（默认）' : ''} ${Number(f.count) || 0} 条`]))),
    vnode('div', { className: 'bl-collection-body' }, [
      confirming
        ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认删除夹' }, [
          vnode('p', {}, [`确认删除「${curFolder.name}」？只删收藏关系，条目本身不动——里面 ${Number(curFolder.count) || 0} 条还会在「库」里看得到。`]),
          vnode('button', { type: 'button', onClick: () => onCancelDelete?.() }, ['取消']),
          vnode('button', { type: 'button', className: 'bl-danger', onClick: () => onDelete?.(curFolder.id) }, ['确认删除'])
        ])
        : vnode('div', { className: 'bl-toolbar' }, [
          vnode('input', {
            type: 'text', 'aria-label': '新建夹名', placeholder: '新建收藏夹（1-40 字）', maxLength: 40,
            value: newFolderName, onChange: (e) => onNewFolderNameChange?.(e?.target?.value ?? '')
          }),
          vnode('button', { type: 'button', onClick: () => onCreate?.(newFolderName) }, ['建夹']),
          vnode('input', {
            type: 'text', 'aria-label': '当前夹名', value: renameValue,
            onChange: (e) => onCurrentNameChange?.(e?.target?.value ?? ''),
            onKeyDown: (e) => { if (e?.key === 'Enter') onRename?.(cur, e?.target?.value ?? renameValue) }
          }),
          vnode('button', { type: 'button', onClick: () => onRename?.(cur, renameValue) }, ['改名']),
          curFolder && !curFolder.is_default
            ? vnode('button', { type: 'button', onClick: () => onAskDelete?.(cur) }, ['删除这个夹'])
            : null
        ].filter(Boolean)),
      note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
      // 读不到夹的时候 items 是"没筛夹"捞回来的全量，跟收藏关系无关，一张卡都不许画
      !unread && items.length
        ? vnode('div', { className: 'bl-grid' }, items.map((i) => CollectedCard({ item: i, folders: list, cur, onOpen })))
        : vnode('p', { className: 'bl-empty' }, [emptyText])
    ])
  ])
}
