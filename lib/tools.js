/**
 * lib/tools.js — agent 工具面：defineTool 的宿主解析 + 本地回退，以及 Baleen 的六个工具。
 *
 * resolveDefineTool / localDefineTool / localParameters / localValueSchema 逐字抄自本机已验证的
 * dsh-study-desk（其 index.js 90-175 行）：@deepseek-ai/dsh-tools 是宿主运行时提供的（打包在
 * app.asar 里），任何 node_modules 里都没有，所以要三级兜底——裸模块名 → resourcesPath 下两个
 * 打包位置 → 本地等价实现。defineTool 不是透传：它把「友好 schema」编译成 registry-ready 的
 * JSON Schema，少了这层编译 register 会抛 JsonSchemaError，所以本地兜底必须老老实实做转换
 * （宿主 API 的实测形态以 study-desk 为唯一可信来源，不要自己发明）。
 *
 * 唯一一处超出 study-desk 原文的扩展：localValueSchema 的 object 分支补了嵌套 properties 的
 * 编译（properties / required / additionalProperties 原样递归带下去）。study-desk 的参数全是
 * 扁平基本类型，用不到嵌套；Baleen 的 save_verdicts 需要「对象数组内嵌三档枚举」在 schema 层
 * 锁死 tier，而嵌套 schema 是宿主友好 schema 支持的形态（dsh-mneme 的 memory_organize 以
 * items:{type:'object', additionalProperties:false, properties:{…}} 注册过）——本地回退若不编译
 * 嵌套，枚举锁会在回退模式下静默丢失，与红线相悖，故补齐。
 */
import { pathToFileURL } from 'node:url'
import {
  VERDICT_TIERS, counts, listItems, getItemById, lastRun,
  candidates as storeCandidates, saveVerdicts, latestDigests,
} from './store.js'
import { fetchBiliSubtitle } from './adapters/bili.js'
import { fetchYtSubtitle, parseVideoId } from './adapters/yt.js'

function localValueSchema(spec) {
  if (spec === undefined || spec === null) return {}
  if (typeof spec !== 'object') return {}
  const type = String(spec.type || '')
  if (type === 'json' || type === 'any' || type === '') return {}   // 无类型约束 = 注解式 schema，register 接受
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    const out = { type }
    if (Array.isArray(spec.enum) && spec.enum.length) out.enum = spec.enum.slice()
    if (spec.description) out.description = String(spec.description)
    return out
  }
  if (type === 'array') {
    const out = { type: 'array', items: localValueSchema(spec.items) }
    if (spec.description) out.description = String(spec.description)
    return out
  }
  if (type === 'object') {
    const out = { type: 'object', additionalProperties: spec.additionalProperties === false ? false : true }
    if (spec.properties && typeof spec.properties === 'object') {
      const props = {}
      const required = []
      for (const [key, value] of Object.entries(spec.properties)) {
        props[key] = localValueSchema(value)
        if (value && value.required === true) required.push(key)
      }
      out.properties = props
      if (required.length) out.required = required
    }
    if (spec.description) out.description = String(spec.description)
    return out
  }
  return {}
}

function localParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec || {})) {
    properties[key] = localValueSchema(value)
    if (value && value.required === true) required.push(key)
  }
  const out = { type: 'object', properties, additionalProperties: false }
  if (required.length) out.required = required
  return out
}

function localDefineTool(options) {
  const output = options.output || {}
  const tool = {
    name: options.name,
    description: options.description,
    parameters: localParameters(options.parameters),
    output: {
      schema: localValueSchema(output.schema),
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) { return options.execute(args, exec) },
  }
  if (typeof output.presentationMeta === 'function') {
    tool.output.presentationMeta = (args, value) => output.presentationMeta(args, value)
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  return tool
}

export async function resolveDefineTool() {
  const candidates = ['@deepseek-ai/dsh-tools']
  try {
    const resources = process.resourcesPath
    if (resources) {
      const base = pathToFileURL(String(resources).replace(/[\\/]+$/, '') + '/').href
      candidates.push(base + 'app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
      candidates.push(base + 'app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    }
  } catch { /* 非 Electron 环境没有 resourcesPath */ }
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (mod && typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, from: spec }
    } catch { /* 试下一个 */ }
  }
  return { defineTool: localDefineTool, from: 'local' }
}

const resolved = await resolveDefineTool()
const defineTool = resolved.defineTool
if (resolved.from === 'local') {
  console.log('[dsh-baleen] 没取到宿主的 @deepseek-ai/dsh-tools，改用本地等价的 defineTool（schema 转换行为一致）')
}

/* ---------------- Baleen 的六个工具 ---------------- */

const STATUSES = ['new', 'judged', 'digest', 'archived']
const KINDS = ['video', 'article', 'note']
const BODY_LIMIT = 20000
const DEFAULT_LIMIT = 20
const DEFAULT_MAX_PER_RUN = 25

/**
 * 同批重复 id 去重，保最后一次（Task 1 评审 minor ②）。整批元素都带整数 id 才去重；
 * 混进坏元素就原样交还 store——校验顺序与报错优先级是 store 的职责，封装层不抢，
 * 否则 [坏, 好] 会被静默洗成 [好]，吞掉本该响亮报出的短码。
 */
function dedupeVerdicts(raw) {
  if (!Array.isArray(raw)) return raw
  const byId = new Map()
  for (const v of raw) {
    if (v == null || typeof v !== 'object' || !Number.isInteger(v.id)) return raw
    byId.set(v.id, v)
  }
  return raw.length === byId.size ? raw : [...byId.values()]
}

/**
 * 工具清单的摘要投影：正文全文不进任何列表返回（一条 2 万字的正文就能撑爆会话上下文，
 * 读全文是 read_item 的事），字段集合在测试里逐字钉死。
 */
function toSummary(r) {
  return {
    id: r.id, title: r.title, kind: r.kind, source_id: r.source_id, published_at: r.published_at,
    status: r.status, verdict_tier: r.verdict_tier, prefilter_score: r.prefilter_score, body_state: r.body_state,
  }
}

/** 从条目 URL / external_id 提取 B 站 bvid（BV + 10 位字母数字）；不是 B 站视频返回 null。 */
function bvidOf(item) {
  const m = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/i.exec(String(item?.url ?? ''))
  if (m) return m[1]
  const ext = String(item?.external_id ?? '')
  return /^BV[0-9A-Za-z]{10}$/.test(ext) ? ext : null
}

/** 条目 URL 是否 YouTube 域（watch 长链 / youtu.be 短链都在其上）；与 parseVideoId 的认域对口，大小写规则也一致。 */
function isYtUrl(s) {
  return /(?:^|[./])youtube\.com\//.test(s) || /(?:^|[./])youtu\.be\//.test(s)
}

/** 字幕全文与 read_item 的正文同一 2 万字顶：一条超长字幕一样能撑爆会话上下文。 */
function clipSubtitle(text) {
  const full = String(text)
  return full.length > BODY_LIMIT
    ? {
        subtitle_text: full.slice(0, BODY_LIMIT),
        subtitle_truncated: true,
        subtitle_original_length: full.length,
        subtitle_note: `已截断，原长 ${full.length} 字`,
      }
    : { subtitle_text: full }
}

/** 六个工具的工厂。defineTool 已在模块装载时解析完（宿主形态或本地回退），这里只做拼装。
 *  fetchImpl / spawnImpl 只给测试注入 bili fetch / yt-dlp spawn 桩用，生产留空走适配器的真实现。 */
export function baleenTools({ db, getPref, now = Date.now, fetchImpl, spawnImpl } = {}) {
  const maxPerRun = () => {
    const v = getPref()?.pref?.schedule?.max_per_run
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_PER_RUN
  }

  const queryTool = defineTool({
    name: 'baleen.query',
    description:
      '翻 Baleen 库里已抓到的条目：按状态/类型/档位/时间筛选，返回摘要（id、标题、类型、来源、published_at、'
      + '状态、档位、预筛分、正文形态），不含正文全文——读全文用 baleen.read_item。'
      + '想盘点库里有什么、找某段时间的条目、按档位回看判断时用它；默认只给未归档的条目。',
    parameters: {
      status: { type: 'string', enum: STATUSES, description: '条目状态：new 待判 / judged 已判 / digest 已进汇报 / archived 已归档；省略 = 前三种' },
      kind: { type: 'string', enum: KINDS, description: '条目类型：video / article / note；省略 = 全部' },
      tier: { type: 'string', enum: VERDICT_TIERS, description: '判档：值得看 / 可以看 / 不值当；省略 = 全部' },
      since: { type: 'number', description: '只看这之后抓到的条目（毫秒时间戳）' },
      limit: { type: 'number', description: '最多返回几条（1-100，默认 20）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.query：${value?.ok ? `${value.items.length} 条` : '取数失败'}` }],
    },
    async execute(args) {
      const a = args ?? {}
      const rows = listItems(db, {
        status: STATUSES.includes(a.status) ? String(a.status) : 'new,judged,digest',
        kind: KINDS.includes(a.kind) ? String(a.kind) : null,
        tier: VERDICT_TIERS.includes(a.tier) ? String(a.tier) : null,
        since: Number.isFinite(a.since) ? a.since : null,
        limit: Number.isFinite(a.limit) ? Math.min(100, Math.max(1, Math.round(a.limit))) : DEFAULT_LIMIT,
      })
      return { ok: true, items: rows.map(toSummary) }
    },
  })

  const readItemTool = defineTool({
    name: 'baleen.read_item',
    description:
      '按 id 读单条完整内容：标题、链接、作者、正文或字幕全文（超两万字会截断并注明原长）、主题命中（match）'
      + '与现有判断。判断一条候选之前先用它读正文，不要只凭标题下结论。',
    parameters: {
      id: { type: 'integer', required: true, description: '条目 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.read_item：${value?.ok ? String(value.title ?? '') : String(value?.error ?? '取数失败')}` }],
    },
    async execute(args) {
      const id = args?.id
      // 非整数 id 与查不到同话：no_item。不新造短码，读不到就是读不到。
      if (!Number.isInteger(id)) return { ok: false, error: 'no_item' }
      const item = getItemById(db, id)
      if (!item) return { ok: false, error: 'no_item' }
      const full = item.body_text == null ? null : String(item.body_text)
      const truncated = full != null && full.length > BODY_LIMIT
      let match = null
      try { match = item.match_json ? JSON.parse(item.match_json) : null } catch { match = null }
      return {
        ok: true,
        id: item.id, title: item.title, kind: item.kind, source_id: item.source_id,
        url: item.url, author: item.author, published_at: item.published_at, fetched_at: item.fetched_at,
        body_state: item.body_state,
        body_text: truncated ? full.slice(0, BODY_LIMIT) : full,
        ...(truncated ? { body_truncated: true, body_original_length: full.length, body_note: `已截断，原长 ${full.length} 字` } : {}),
        match,
        status: item.status, verdict_tier: item.verdict_tier, verdict_why: item.verdict_why,
      }
    },
  })

  const candidatesTool = defineTool({
    name: 'baleen.candidates',
    description:
      '取本轮待判候选（按预筛分从高到低，上限来自配置的每轮条数，total 是待判总数）。'
      + '开始一轮判断时先调它，再逐条 baleen.read_item 读正文，最后用 baleen.save_verdicts 写回三档判断。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.candidates：待判 ${value?.ok ? value.total : '?'}` }],
    },
    async execute() {
      const max = maxPerRun()
      const rows = storeCandidates(db, max)
      return { ok: true, total: counts(db).new, max_per_run: max, items: rows.map(toSummary) }
    },
  })

  const runStatusTool = defineTool({
    name: 'baleen.run_status',
    description:
      '看最近一轮摄取的状态：整轮成败、各源抓取摘要、候选数，以及库里各状态条目的计数。'
      + 'inject_prompt 如实反映注入开关（preference.yaml 顶层键，默认开；注入把待判数与失败源带进会话）。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.run_status：${value?.last_run ? `上轮 ${value.last_run.status}` : '还没跑过'}` }],
    },
    async execute() {
      const run = lastRun(db)
      let perSource = null
      try { perSource = run?.per_source_json ? JSON.parse(run.per_source_json) : null } catch { perSource = null }
      const injectPref = getPref?.()?.pref?.inject_prompt
      return {
        ok: true,
        last_run: run ? {
          id: run.id, status: run.status, trigger: run.trigger,
          started_at: run.started_at, finished_at: run.finished_at,
          candidates: run.candidates, judged: run.judged, per_source: perSource, error: run.error ?? null,
        } : null,
        counts: counts(db),
        // M3 Task 3 接真值：注入开关（缺省即开；偏好校验失败时按默认走，与 loadPreference 契约一致）
        inject_prompt: typeof injectPref === 'boolean' ? injectPref : true,
      }
    },
  })

  const subtitleTool = defineTool({
    name: 'baleen.subtitle',
    description:
      '现取一条视频的字幕全文（B 站 / YouTube 通道）：给条目 id，返回字幕全文与该条的标题/链接。'
      + '判断时正文是 summary_only 的视频用它补全文——读完字幕再下结论。'
      + '库内已有字幕全文就直接回文本不再现取；只读工具，不写任何数据。',
    parameters: {
      id: { type: 'integer', required: true, description: '条目 id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.subtitle：${value?.ok ? String(value.title ?? '') : String(value?.error ?? '取数失败')}` }],
    },
    async execute(args) {
      const id = args?.id
      // 与 read_item 同话：非整数 id 与查不到都是 no_item，不新造短码
      if (!Number.isInteger(id)) return { ok: false, error: 'no_item' }
      const item = getItemById(db, id)
      if (!item) return { ok: false, error: 'no_item' }
      const base = { id: item.id, title: item.title, url: item.url, body_state: item.body_state }
      if (item.kind !== 'video') return { ok: false, error: 'not_video', ...base }
      // 按条目 URL 分流（M4b Task 2）：B 站走 bvid 提取 + api 现取；YouTube 走视频 id + yt-dlp 落盘现取。
      // 两路都提不出视频标识 → 同一短码 no_bvid（不新造）；yt 路径用 detail 写明原因。
      const url = String(item.url ?? '')
      const viaYt = isYtUrl(url)
      const bvid = viaYt ? null : bvidOf(item)
      const ytId = viaYt ? parseVideoId(url) : null
      if (!bvid && !ytId) {
        return { ok: false, error: 'no_bvid', ...(viaYt ? { detail: 'YouTube URL 提取不出视频 id' } : null), ...base }
      }
      // 库内已有字幕全文（body_state=subtitle 且 body_text 非空）→ 直接回库内文本，不发请求（两通道同规则）
      const stored = item.body_text == null ? '' : String(item.body_text).trim()
      if (item.body_state === 'subtitle' && stored) {
        return { ok: true, ...base, from_store: true, ...clipSubtitle(item.body_text) }
      }
      // missing / burned_in（以及库内没全文的 subtitle）→ 现取：bili 直连 api.bilibili.com（view 拿 cid 后取字幕）；
      // yt 走 yt-dlp 落盘按优先级挑文件（zh-Hans > … > en，轨间回退）——与抓取路径同一实现
      try {
        const text = viaYt
          ? await fetchYtSubtitle(ytId, { spawnImpl, pref: getPref?.()?.pref ?? null })
          : await fetchBiliSubtitle(bvid, { fetchImpl, pref: getPref?.()?.pref ?? null })
        if (!text) return { ok: false, error: 'no_subtitle', ...base }
        return { ok: true, ...base, from_store: false, ...clipSubtitle(text) }
      } catch (e) {
        // 适配器错误消息已按红线脱敏（只指文件名、无家目录绝对路径），截 160 字带给模型
        return { ok: false, error: 'fetch_failed', detail: String(e?.message ?? e).slice(0, 160), ...base }
      }
    },
  })

  const saveVerdictsTool = defineTool({
    name: 'baleen.save_verdicts',
    description:
      '把判断写回 Baleen 本地库——唯一会写数据的工具，只动本插件的条目表与汇报表，不碰任何平台。'
      + '每条判断给条目 id、三档之一（值得看/可以看/不值当）与一句话理由；改判就再判一次，新判覆盖旧判；'
      + '同一批重复 id 自动去重保最后一次。档位是枚举，越界的词会被拒。',
    parameters: {
      verdicts: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer', required: true, description: '条目 id（整数）' },
            tier: { type: 'string', required: true, enum: VERDICT_TIERS, description: '三档之一：值得看 / 可以看 / 不值当' },
            why: { type: 'string', required: true, description: '一句话判断理由，写清依据' },
          },
        },
        description: '判断清单，每项 {id, tier, why}；同批重复 id 自动去重保最后一次',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `baleen.save_verdicts：${value?.ok ? String(value.headline ?? '') : String(value?.error ?? '失败')}` }],
    },
    async execute(args) {
      try {
        const out = saveVerdicts(db, dedupeVerdicts(args?.verdicts), now)
        const [d] = latestDigests(db, 1)
        return { ok: true, ...out, headline: d?.headline ?? null }
      } catch (e) {
        // store 抛的就是短码（bad_payload / bad_tier / no_item），原样带给模型，不吞不翻
        return { ok: false, error: String(e?.message ?? e) }
      }
    },
  })

  return [queryTool, readItemTool, candidatesTool, runStatusTool, subtitleTool, saveVerdictsTool]
}
