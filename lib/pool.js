/**
 * pool.js —— 抓取 job 的并发、超时与重试上限。
 *
 * 纪律是这里的主要功能：并发 4、单 job 20s、**重试只有 1 次**。
 * 反复重跑和自写脚本绕过是最烧钱的两种失败方式，这里从结构上不给它们留口子。
 */

export function classifyError(err) {
  if (!err) return 'unknown'
  // 适配器可以钉住分类（bili：credentials / bad_source / network），
  // 钉了就尊重——平台知识归适配器，pool 只兜底。
  if (err.error_class) return err.error_class
  if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return 'timeout'
  if (err.status) return 'http'
  if (err.empty) return 'empty'
  if (err.parse) return 'parse'
  if (err instanceof TypeError) return 'network'
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|Failed to fetch/i.test(err.message || '')) return 'network'
  return 'unknown'
}

async function attempt(promiseFactory, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`超过 ${timeoutMs}ms 无响应`)
      e.name = 'TimeoutError'
      reject(e)
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(promiseFactory), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @returns 与 jobs 同序的结果数组：{ job, ok, value, error, error_class }
 *   runner 依赖顺序来对账每个源的抓取量，所以结果绝不能按完成先后返回。
 */
export async function runJobs(jobs, { limit = 4, timeoutMs = 20000, retries = 1, run } = {}) {
  const list = Array.isArray(jobs) ? jobs : []
  const results = new Array(list.length)
  if (!list.length) return results
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= list.length) return
      const job = list[i]
      // 单 job 可带 timeout_ms 覆盖（个别源需要更宽的预算时用，不设走通用 20s）
      const perJobMs = Number(job.timeout_ms) > 0 ? job.timeout_ms : timeoutMs
      let value = null
      let error = null
      let ok = false
      for (let tries = 0; tries <= retries; tries++) {
        try {
          value = await attempt(() => run(job, { index: i, retry: tries }), perJobMs)
          ok = true
          error = null
          break
        } catch (e) {
          error = e
        }
      }
      results[i] = { job, ok, value, error, error_class: ok ? null : classifyError(error) }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker))
  return results
}
