/**
 * 预览夹具：结构是真的（字段与 items 表一致），内容全是编的。
 * 订阅名一律用 demo-* / 平台代号，不把她真实订阅的源写进这个仓库。
 */
const DAY = 86400000
const T0 = Date.parse('2026-10-24T07:30:00Z')

/**
 * 预览夹：字段与 lib/store.js 的 listFolders 产出逐字一致（{id, name, is_default, count}）。
 * count 不是随手写的：必须等于 previewItems 里实际挂着这个夹的条数——
 * 夹上的数字与点进去看到的条数对不上，收藏页就成了谎报覆盖面的那一格
 * （test/preview.test.js 的"夹具自洽"一条直接盯这件事）。
 */
export const previewFolders = [
  { id: 1, name: '默认', is_default: 1, count: 2 },
  { id: 2, name: '公共管理', is_default: 0, count: 2 },
  { id: 3, name: '要精读', is_default: 0, count: 0 }
]

export const previewState = {
  home: '<HOME>',
  counts: { new: 5, judged: 2, digest: 0, archived: 1, total: 8 },
  digest_count: 0,
  last_run: { id: 3, status: 'partial', at: T0, finished_at: T0 + 42000, candidates: 5, judged: 2 },
  gaps: {
    total_dropped: 23,
    by_reason: { 'no-match': 11, stale: 6, 'no-body': 4, 'too-short': 2 },
    kept_with_flag: { burned_in: 1 },
    // 收藏钉住（D15）：这轮因收藏豁免没清的条数。夹具里仍活着且挂着夹的条目恰好两条
    // （id 1、5；id 8 已归档走的是"不复活"那条路，不进这个桶），所以演 2 而不是随手写个数。
    held: 2
  },
  sources: [
    { id: 'demo-longform', type: 'rss', url: 'https://example.invalid/a/feed', enabled: true, ok: true, error_class: null },
    { id: 'demo-notes', type: 'rss', url: 'https://example.invalid/b/feed', enabled: true, ok: true, error_class: null },
    { id: 'demo-weekly', type: 'rss', url: 'https://example.invalid/c/feed', enabled: true, ok: false, error_class: 'timeout' },
    { id: 'bili', type: 'mcp', url: null, enabled: true, ok: false, error_class: 'needs_login' }
  ],
  preference_errors: [],
  schedule: { windows: ['07:00-09:00', '21:00-23:00'], max_per_run: 25, interval_min: 60 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] }
}

const base = (over) => ({
  source_id: 'demo-longform', kind: 'article', status: 'new', body_state: 'full',
  author: '某作者', published_at: T0 - DAY, fetched_at: T0, prefilter_score: 2,
  verdict_tier: null, verdict_why: null, time_estimated: 6, thumb: null, duration_sec: null,
  url: 'https://example.invalid/post', body_text: '', summary_hint: '', archived_reason: null,
  // 字段名与 itemsWithFolders 的产出逐字一致（folders/folder_names/added_at）：
  // 预览用别名会在真机上静默空白，不是"少了几个字段"那么简单。
  folders: [], folder_names: [], added_at: T0,
  match_json: '{"reason":"命中 治理（公共管理）","hitKeywords":["治理"],"groups":["公共管理"]}', ...over
})

export const previewItems = [
  base({
    id: 1, kind: 'video', source_id: 'bili', title: '把插件拆成宿主半与客户端半：一次实做记录',
    author: 'UP某某', duration_sec: 1102, body_state: 'subtitle', time_estimated: 18, prefilter_score: 4,
    url: 'https://example.invalid/video', body_text: '（字幕原文节选）我们先讲装配，再讲取数，最后讲为什么路由只能挂在 /api 下。',
    folders: [1, 2], folder_names: ['默认', '公共管理'], added_at: T0 - 2 * DAY,
    match_json: '{"reason":"命中 DSH（AI 工具）","hitKeywords":["DSH"],"groups":["AI 工具"]}'
  }),
  base({
    id: 2, kind: 'video', source_id: 'bili', title: '信息过载的三种解法，第三种 Most 人都没做对',
    duration_sec: 48, body_state: 'missing', prefilter_score: 1, status: 'new',
    match_json: '{"reason":"命中 信息（主题组）","hitKeywords":["信息"],"groups":["方法论"]}'
  }),
  base({
    id: 3, kind: 'note', source_id: 'demo-notes', title: '图文笔记：我的订阅清单怎么收拾',
    body_state: 'full', time_estimated: 3, prefilter_score: 3,
    url: 'https://example.invalid/note', body_text: '先删号，再降频，最后才是换工具。',
    match_json: '{"reason":"关注源 demo-notes","hitKeywords":[],"groups":["方法论"]}'
  }),
  base({
    id: 4, kind: 'article', source_id: 'demo-longform', title: '为什么 RSS 在 2026 年还活着',
    body_state: 'summary_only', summary_hint: '这个源只输出了摘要。', body_text: null, time_estimated: 9,
    prefilter_score: 3, url: 'https://example.invalid/abstract',
    match_json: '{"reason":"命中 订阅（公共管理）","hitKeywords":["订阅"],"groups":["公共管理"]}'
  }),
  base({
    id: 5, kind: 'article', source_id: 'demo-longform', title: '把决定权留给人的三种界面',
    body_state: 'full', prefilter_score: 5, time_estimated: 12, url: 'https://example.invalid/ux',
    body_text: '第一，别替用户点按钮；第二，把"为什么"写在旁边；第三，允许反悔。\n\n（夹具正文，非真实文章。）',
    folders: [2], folder_names: ['公共管理'], added_at: T0 - DAY,
    match_json: '{"reason":"命中 界面（方法论）","hitKeywords":["界面"],"groups":["方法论"]}'
  }),
  base({
    id: 6, kind: 'article', source_id: 'demo-notes', title: '讨论串：读不完的东西到底要不要读',
    body_state: 'summary_only', summary_hint: '只有评论摘要。', body_text: null, prefilter_score: 2,
    status: 'judged', verdict_tier: '可以看', verdict_why: '给了一个能落地的判断标准，但例证偏少',
    url: 'https://example.invalid/thread',
    match_json: '{"reason":"命中 读（主题词）","hitKeywords":["读"],"groups":["方法论"]}'
  }),
  base({
    id: 7, kind: 'video', source_id: 'bili', title: '盘点十个"AI 神器"，第九个我不敢用',
    duration_sec: 612, body_state: 'burned_in', prefilter_score: 1, status: 'judged',
    verdict_tier: '不值当', verdict_why: '全程只有标题堆砌，没有一处可核验的操作',
    url: 'https://example.invalid/list', body_text: null,
    match_json: '{"reason":"命中 AI（AI 工具）","hitKeywords":["AI"],"groups":["AI 工具"]}'
  }),
  base({
    id: 8, kind: 'article', source_id: 'demo-weekly', title: '（一条被归档的旧文）',
    status: 'archived', archived_reason: 'stale:20 天前', prefilter_score: 0,
    published_at: T0 - 20 * DAY, url: 'https://example.invalid/old', body_text: '',
    // 已归档也照样挂夹：它是"收了但今天看不见"的活样本，收藏页那行红字全靠它演
    folders: [1], folder_names: ['默认'], added_at: T0 - 3 * DAY,
    match_json: '{}'
  })
]
