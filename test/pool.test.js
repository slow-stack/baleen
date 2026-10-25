import test from 'node:test'
import assert from 'node:assert/strict'
import { runJobs, classifyError } from '../lib/pool.js'

test('并发不超过 limit，全部 job 都有结果', async () => {
  let live = 0, peak = 0
  const jobs = Array.from({ length: 9 }, (_, i) => ({ id: i }))
  const res = await runJobs(jobs, {
    limit: 4, timeoutMs: 1000, retries: 0,
    run: async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return 'ok' }
  })
  assert.equal(res.length, 9)
  assert.equal(peak, 4)
  assert.ok(res.every(r => r.ok))
})

test('结果顺序与 job 顺序一致（runner 靠这个对账）', async () => {
  const jobs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const res = await runJobs(jobs, {
    limit: 3, timeoutMs: 500, retries: 0,
    run: async (job) => { await new Promise(r => setTimeout(r, job.id === 'a' ? 20 : 1)); return job.id }
  })
  assert.deepEqual(res.map(r => r.job.id), ['a', 'b', 'c'])
  assert.deepEqual(res.map(r => r.value), ['a', 'b', 'c'])
})

test('超时按 timeout 分类，并重试 1 次后放弃', async () => {
  let calls = 0
  const res = await runJobs([{ id: 'slow' }], {
    limit: 1, timeoutMs: 20, retries: 1,
    run: () => { calls++; return new Promise(() => {}) }
  })
  assert.equal(res[0].ok, false)
  assert.equal(res[0].error_class, 'timeout')
  assert.equal(calls, 2)
})

test('重试成功就不算失败', async () => {
  let calls = 0
  const res = await runJobs([{ id: 'flaky' }], {
    limit: 1, timeoutMs: 500, retries: 1,
    run: async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return 'ok' }
  })
  assert.equal(res[0].ok, true)
  assert.equal(res[0].value, 'ok')
  assert.equal(calls, 2)
})

test('重试上限就是 1 次，不会变成反复重跑', async () => {
  let calls = 0
  await runJobs([{ id: 'dead' }], {
    limit: 1, timeoutMs: 500, retries: 1,
    run: async () => { calls++; throw new Error('boom') }
  })
  assert.equal(calls, 2)
})

test('空 job 列表不炸', async () => {
  const res = await runJobs([], { limit: 4, timeoutMs: 10, retries: 1, run: async () => 'x' })
  assert.deepEqual(res, [])
})

test('错误分类覆盖 timeout / http / empty / parse / network / unknown', () => {
  const t = new Error('x'); t.name = 'TimeoutError'
  assert.equal(classifyError(t), 'timeout')
  assert.equal(classifyError(new TypeError('fetch failed')), 'network')
  assert.equal(classifyError(Object.assign(new Error('403'), { status: 403 })), 'http')
  assert.equal(classifyError(Object.assign(new Error('无条目'), { empty: true })), 'empty')
  assert.equal(classifyError(Object.assign(new Error('x'), { parse: true })), 'parse')
  assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND x')), 'network')
  assert.equal(classifyError(new Error('?')), 'unknown')
  assert.equal(classifyError(null), 'unknown')
})

test('适配器钉住的 error_class 优先于通用分类（bili：credentials/bad_source 等）', () => {
  assert.equal(classifyError(Object.assign(new Error('B 站凭据被拒'), { error_class: 'credentials' })), 'credentials')
  assert.equal(classifyError(Object.assign(new Error('无 UID'), { error_class: 'bad_source' })), 'bad_source')
  // 没钉住的照旧走通用分类
  assert.equal(classifyError(Object.assign(new Error('403'), { status: 403 })), 'http')
})

test('超时即 abort：timeout 的同时 run 收到的 signal 变 aborted（真机 run 17 的孤儿调用消失）', async () => {
  let seen = null
  const res = await runJobs([{ id: 'slow' }], {
    limit: 1, timeoutMs: 20, retries: 0,
    run: (job, opts = {}) => {
      seen = opts.signal ?? null
      return new Promise((_, reject) => {
        const abortErr = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
        if (seen?.aborted) return reject(abortErr())
        seen?.addEventListener('abort', () => reject(abortErr()))
      })
    }
  })
  assert.equal(res[0].ok, false)
  assert.equal(res[0].error_class, 'timeout')
  assert.ok(seen, 'run 必须收到 signal')
  assert.equal(seen.aborted, true, '超时后 signal 必须已 abort')
})

test('重试拿到新 signal：上一轮超时的 abort 不毒死重试（慢源仍有两次完整预算）', async () => {
  const signals = []
  const res = await runJobs([{ id: 'slow-then-ok' }], {
    limit: 1, timeoutMs: 20, retries: 1,
    run: (job, opts = {}) => {
      signals.push(opts.signal ?? null)
      if (signals.length === 1) return new Promise(() => {})
      return 'ok'
    }
  })
  assert.equal(res[0].ok, true)
  assert.ok(signals[0], 'run 必须收到 signal')
  assert.equal(signals[0].aborted, true, '第一轮超时后 signal 必须已 abort')
  assert.equal(signals[1].aborted, false, '重试拿到的必须是未 abort 的新 signal')
})

test('job.timeout_ms 覆盖整批 timeoutMs（个别源需要更宽预算的口子）', async () => {
  const res = await runJobs([{ id: 'slow-source', timeout_ms: 400 }], {
    limit: 1, timeoutMs: 20, retries: 0,
    run: () => new Promise(r => setTimeout(r, 60))
  })
  assert.equal(res[0].ok, true)
  const res2 = await runJobs([{ id: 'over', timeout_ms: 10 }], {
    limit: 1, timeoutMs: 500, retries: 0,
    run: () => new Promise(() => {})
  })
  assert.equal(res2[0].ok, false)
  assert.equal(res2[0].error_class, 'timeout')
})
