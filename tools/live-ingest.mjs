/**
 * tools/live-ingest.mjs —— 不经 DSH，直接跑一轮真实摄取。
 *
 * 用法：
 *   BALEEN_HOME=D:/tmp/baleen-live node tools/live-ingest.mjs
 *   加 --reset 先把这个临时家目录的库删掉（从零开始看首轮全量抓取）。
 *
 * 它用一个假 ctx 装上宿主半（只关心 apply() 里的装配与路由逻辑能否跑通），
 * 定时器注入 no-op，跑完就退出——不留后台 interval。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.js'

const home = process.env.BALEEN_HOME
if (!home) {
  console.error('必须先设 BALEEN_HOME，否则会把真库写进 ~/.dsh/baleen')
  process.exit(1)
}
if (process.argv.includes('--reset')) {
  for (const f of ['baleen.sqlite', 'baleen.sqlite-wal', 'baleen.sqlite-shm']) {
    try { fs.rmSync(path.join(home, f), { force: true }) } catch { /* 没建过就算了 */ }
  }
  console.log('已清库')
}

const noop = () => {}
const ctx = {
  get: () => undefined,
  webServer: undefined,
  provide: noop,
  effect: (fn) => { try { fn() } catch (e) { console.error('effect 失败：', e.message) } }
}

const baleen = apply(ctx, { setInterval: () => ({ id: 0 }), clearInterval: noop })
const st = baleen.state()
console.log('偏好来源:', fs.existsSync(path.join(home, 'preference.yaml')) ? 'preference.yaml' : '内置默认')
console.log('启用源:', st.sources.filter(s => s.enabled).map(s => s.id).join(', ') || '（无）')
console.log('偏好错误:', st.preference_errors.length ? st.preference_errors : '无')

const t0 = Date.now()
const run = await baleen.runNow()
console.log(`\n本轮 ${run.skipped ? '被跳过：' + run.why : `run#${run.runId} → ${run.status}`}  用时 ${Date.now() - t0}ms`)
if (!run.skipped) {
  const s = run.stats
  console.log(`抓 ${s.fetched} → 入库 ${s.inserted}｜刷新 ${s.updated}｜重复 ${s.duplicate}｜丢弃 ${s.archived}｜候选 ${s.candidates}`)
  const gaps = s.gaps ?? { by_reason: {}, kept_with_flag: {}, total_dropped: 0 }
  console.log('丢弃明细:', JSON.stringify(gaps.by_reason), '带标记保留:', JSON.stringify(gaps.kept_with_flag))
  for (const [id, r] of Object.entries(s.per_source ?? {})) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${id}: ${r.ok ? `抓 ${r.fetched} → 候选 ${r.candidates}` : `失败(${r.error_class})`}`)
  }
}

const db = new DatabaseSync(path.join(home, 'baleen.sqlite'))
console.log('\nbody_state 分布（V6 就看这一列）：')
for (const r of db.prepare('SELECT source_id, body_state, COUNT(*) n FROM items GROUP BY source_id, body_state ORDER BY source_id').all()) {
  console.log(`  ${r.source_id.padEnd(18)} ${r.body_state.padEnd(13)} ${r.n}`)
}
console.log('\n游标：')
for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'cursor:%' ORDER BY key").all()) {
  console.log(`  ${r.key.padEnd(24)} ${r.value}`)
}
console.log('\n各源最近一次状态：')
for (const r of baleen.state().sources) {
  console.log(`  ${r.id.padEnd(18)} ok=${r.ok} class=${r.error_class} cursor=${r.cursor ?? 'null'}`)
}
db.close()
