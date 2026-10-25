import crypto from 'node:crypto'

/**
 * bili-wbi.js —— B 站 wbi 签名（自研，零依赖，MD5 走 node:crypto）。
 *
 * 算法是公开资料（bilibili-API-collect 的 wbi 文档），置换表是固定常量，签名纯确定性：
 *  1. nav 接口（匿名可调，返回体 code=-101「账号未登录」但 data.wbi_img 照给）
 *     的 img_url / sub_url 各取文件名，即 img_key / sub_key；
 *  2. sub_key 拼在 img_key 后，按 64 长度置换表 MIXIN_KEY_ENC_TAB 重排，取前 32 位 = mixin_key；
 *  3. 请求参数加 wts（unix 秒），按 key 排序，值里剔除 !'()*，encodeURIComponent 拼成 query；
 *  4. w_rid = MD5(query + mixin_key)，与 wts 一起并进 query 发出去。
 * 向量已钉在 test/adapters-bili.test.js（img=7cd0…、sub=4932… ⇒ mixin=ea1d…；
 * {foo,bar,zab}+wts=1702204169 ⇒ w_rid=8f6f…），改动算法必红。
 */

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

/** dsh-bili-scroll 实测可用的匿名请求头（coverFor，index.js:2158）：诚实通用 UA + bilibili 站内 referer。 */
export const BILI_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' }

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
/** mixin key 一天一换；缓存半天，长驻进程也不会拿着过期的 key 签一星期。 */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CHR_FILTER = /[!'()*]/g

function fail(message, props = {}) {
  return Object.assign(new Error(message), props)
}

export function getMixinKey(imgKey, subKey) {
  const raw = String(imgKey ?? '') + String(subKey ?? '')
  let out = ''
  for (const i of MIXIN_KEY_ENC_TAB) out += raw[i] ?? ''
  return out.slice(0, 32)
}

/** wbi 图床 URL 取文件名（img/sub key 的来源）；不是预期形态返回 null。 */
export function keyFromUrl(url) {
  const m = /\/([^/]+)\.\w+$/.exec(String(url ?? ''))
  return m ? m[1] : null
}

/** 官方算法第 3-4 步：不动入参，返回带 wts / w_rid 的新参数对象。 */
export function wbiSignParams(params, { mixinKey, wts }) {
  const all = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map(k => `${encodeURIComponent(String(k).replace(CHR_FILTER, ''))}=${encodeURIComponent(String(all[k]).replace(CHR_FILTER, ''))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
  return { ...all, w_rid }
}

// ── nav 缓存（进程内） ────────────────────────────────────────────────────

let cache = null // { mixinKey, at }
export function clearWbiCache() { cache = null }

async function mixinKeyFor({ fetchImpl, now, ttlMs, signal }) {
  if (cache && now() - cache.at < ttlMs) return cache.mixinKey
  let res
  try {
    // signal 透传：pool 超时即 abort 时，nav 这个"还在飞"的请求也要断得掉（全链不落孤儿）。
    res = await fetchImpl(NAV_URL, { headers: BILI_HEADERS, signal })
  } catch (e) {
    throw e // fetch 失败原样上抛（pool 按 network 分类）
  }
  if (!res?.ok) {
    throw fail(`B 站 nav HTTP ${res?.status ?? '?'}`, { status: res?.status ?? 0 })
  }
  let body
  try { body = await res.json() } catch { throw fail('B 站 nav 响应不是 JSON', { parse: true }) }
  const img = keyFromUrl(body?.data?.wbi_img?.img_url)
  const sub = keyFromUrl(body?.data?.wbi_img?.sub_url)
  if (!img || !sub) {
    // nav 匿名时 code=-101 但 wbi_img 照给；走到这儿是连 key 都拿不到，诚实失败
    throw fail('B 站 nav 响应缺 data.wbi_img（拿不到 wbi key）', { error_class: 'network' })
  }
  cache = { mixinKey: getMixinKey(img, sub), at: now() }
  return cache.mixinKey
}

/**
 * wbi 签名器：sign(params) → 带 wts / w_rid 的完整参数对象。
 * mixin key 进程内缓存（见 CACHE_TTL_MS）；fetchImpl 只给测试注入桩用。
 * signal（可选）：缓存未命中要打 nav 时带上——pool 超时 abort 才能把它也断掉。
 */
export function createWbiSigner({ fetchImpl = globalThis.fetch, now = Date.now, ttlMs = CACHE_TTL_MS, signal } = {}) {
  return {
    async sign(params) {
      const mixinKey = await mixinKeyFor({ fetchImpl, now, ttlMs, signal })
      return wbiSignParams(params, { mixinKey, wts: Math.floor(now() / 1000) })
    }
  }
}
