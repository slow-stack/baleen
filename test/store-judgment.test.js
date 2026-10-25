import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, migrate, createRun, saveVerdicts, latestDigests, listItems, getItemById
} from '../lib/store.js'

// 建库与造数手法照抄 test/store-collections.test.js 的 dbOf/row/insRow。
const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
const row = (over = {}) => ({
  source_id: 's1', external_id: 'e1', kind: 'article', title: 't', url: 'https://e.com/1',
  author: null, author_id: null, published_at: 900, time_estimated: 0, fetched_at: 1000,
  thumb: null, duration_sec: null, stats_json: null, tags_json: null, locale: null,
  body_text: 'x', body_state: 'full', match_json: '{}', prefilter_score: 1, status: 'new', ...over
})
const insRow = (db, over) => db.prepare(`INSERT INTO items (
  source_id, external_id, kind, title, url, author, author_id, published_at, time_estimated, fetched_at,
  thumb, duration_sec, stats_json, tags_json, locale, body_text, body_state, match_json, prefilter_score, status
) VALUES (@source_id, @external_id, @kind, @title, @url, @author, @author_id, @published_at, @time_estimated, @fetched_at,
  @thumb, @duration_sec, @stats_json, @tags_json, @locale, @body_text, @body_state, @match_json, @prefilter_score, @status)`
).run(row(over))
const ins = (db, over) => Number(insRow(db, over).lastInsertRowid)
const digestCount = (db) => db.prepare('SELECT COUNT(*) n FROM digests').get().n

test('三档合法写入：status 变 judged，tier/why 落库，listItems({tier}) 查得回', () => {
  const db = dbOf()
  // 判定成功要落一条 digest，digests.run_id 是 NOT NULL，库里得先有一轮
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  const b = ins(db, { external_id: 'b' })
  const c = ins(db, { external_id: 'c' })
  const out = saveVerdicts(db, [
    { id: a, tier: '值得看', why: '给了可复现的操作步骤' },
    { id: b, tier: '可以看', why: '结论可用但例证偏少' },
    { id: c, tier: '不值当', why: '通篇标题堆砌' },
  ])
  assert.deepEqual(out, { judged: 3, tiers: { '值得看': 1, '可以看': 1, '不值当': 1 } },
    '返回对象只有计数，不带任何正文内容')
  for (const [id, tier, why] of [
    [a, '值得看', '给了可复现的操作步骤'],
    [b, '可以看', '结论可用但例证偏少'],
    [c, '不值当', '通篇标题堆砌'],
  ]) {
    const item = getItemById(db, id)
    assert.equal(item.status, 'judged')
    assert.equal(item.verdict_tier, tier)
    assert.equal(item.verdict_why, why)
  }
  assert.deepEqual(listItems(db, { tier: '值得看' }).map((r) => r.id), [a])
  assert.deepEqual(listItems(db, { tier: '可以看' }).map((r) => r.id), [b])
  assert.deepEqual(listItems(db, { tier: '不值当' }).map((r) => r.id), [c])
  db.close()
})

test('越界 tier 拒绝：bad_tier，三档之外的词与类型一个都进不了库', () => {
  const db = dbOf()
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  assert.throws(() => saveVerdicts(db, [{ id: a, tier: '必看', why: '自创档位' }]), /bad_tier/)
  assert.throws(() => saveVerdicts(db, [{ id: a, tier: 3, why: '档位给了数字' }]), /bad_tier/)
  // 校验顺序：同一元素上档位越界先于条目查无
  assert.throws(() => saveVerdicts(db, [{ id: 9999, tier: '值得个看', why: 'x' }]), /bad_tier/)
  const item = getItemById(db, a)
  assert.equal(item.status, 'new')
  assert.equal(item.verdict_tier, null)
  assert.equal(digestCount(db), 0, '被拒的批次连 digest 都不该留')
  db.close()
})

test('bad_payload：非数组、空数组、缺 id/tier/why、id 非整数、why 空串一律响亮拒', () => {
  const db = dbOf()
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  const v = (over) => ({ id: a, tier: '可以看', why: 'x', ...over })
  assert.throws(() => saveVerdicts(db, null), /bad_payload/)
  assert.throws(() => saveVerdicts(db, '值得看'), /bad_payload/)
  assert.throws(() => saveVerdicts(db, {}), /bad_payload/)
  assert.throws(() => saveVerdicts(db, []), /bad_payload/, '空批不落 digest，也不许静默当成功')
  assert.throws(() => saveVerdicts(db, [v({ id: undefined })]), /bad_payload/)
  assert.throws(() => saveVerdicts(db, [v({ tier: undefined })]), /bad_payload/)
  assert.throws(() => saveVerdicts(db, [v({ why: undefined })]), /bad_payload/)
  assert.throws(() => saveVerdicts(db, [v({ id: 1.5 })]), /bad_payload/, 'id 非整数')
  assert.throws(() => saveVerdicts(db, [v({ id: '1' })]), /bad_payload/)
  assert.throws(() => saveVerdicts(db, [v({ why: '' })]), /bad_payload/, '空理由不许落库')
  assert.throws(() => saveVerdicts(db, [null]), /bad_payload/)
  // 校验顺序：同一元素上载荷坏先于档位越界
  assert.throws(() => saveVerdicts(db, [v({ why: '', tier: '必看' })]), /bad_payload/)
  assert.equal(digestCount(db), 0)
  assert.equal(getItemById(db, a).status, 'new')
  db.close()
})

test('no_item 整批回滚：第二批混一条坏 id，第二批的合法项不落，第一批原判不动', () => {
  const db = dbOf()
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  const b = ins(db, { external_id: 'b' })
  saveVerdicts(db, [{ id: a, tier: '值得看', why: '第一批判了' }])
  assert.throws(() => saveVerdicts(db, [
    { id: b, tier: '可以看', why: '这条是合法的' },
    { id: 9999, tier: '不值当', why: '这条 id 不存在' },
  ]), /no_item/)
  assert.equal(getItemById(db, a).verdict_tier, '值得看', '第一批的判断不该被第二批的失败带走')
  const itemB = getItemById(db, b)
  assert.equal(itemB.status, 'new')
  assert.equal(itemB.verdict_tier, null, '合法项也不许落下——整批回滚，不留半批')
  assert.equal(digestCount(db), 1, '失败的批次不追加 digest')
  db.close()
})

test('覆盖改判：再判一次换档换理由，落库的是新判，旧档查询里不再出现', () => {
  const db = dbOf()
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  saveVerdicts(db, [{ id: a, tier: '值得看', why: '初判' }])
  saveVerdicts(db, [{ id: a, tier: '不值当', why: '复看后降档' }])
  const item = getItemById(db, a)
  assert.equal(item.status, 'judged')
  assert.equal(item.verdict_tier, '不值当')
  assert.equal(item.verdict_why, '复看后降档')
  assert.deepEqual(listItems(db, { tier: '值得看' }), [], '旧档位查询里不该再有这条')
  db.close()
})

test('digest 落一条：headline 计数与 tiers 同源，run_id 取 lastRun，stats_json 带同一时间戳', () => {
  const db = dbOf()
  createRun(db, 'manual', () => 1000)
  const a = ins(db, { external_id: 'a' })
  const b = ins(db, { external_id: 'b' })
  const out = saveVerdicts(db, [
    { id: a, tier: '值得看', why: 'x' },
    { id: b, tier: '不值当', why: 'y' },
  ], () => 2000)
  const rows = db.prepare('SELECT * FROM digests').all()
  assert.equal(rows.length, 1)
  const d = rows[0]
  assert.equal(d.run_id, 1, '这批候选来自最近摄取轮')
  assert.equal(d.created_at, 2000)
  assert.equal(d.headline, '判了 2 条：值得看 1 · 可以看 0 · 不值当 1')
  assert.deepEqual(JSON.parse(d.stats_json), { judged: 2, tiers: { '值得看': 1, '可以看': 0, '不值当': 1 }, at: 2000 })
  assert.equal(d.markdown_path, null)
  assert.equal(d.theme_json, null)
  assert.deepEqual(out, { judged: 2, tiers: { '值得看': 1, '可以看': 0, '不值当': 1 } })
  db.close()
})

test('latestDigests：id 倒序、limit 生效，列就是 state() 要的四样', () => {
  const db = dbOf()
  createRun(db, 'manual')
  const a = ins(db, { external_id: 'a' })
  saveVerdicts(db, [{ id: a, tier: '值得看', why: '第一批' }], () => 2000)
  saveVerdicts(db, [{ id: a, tier: '可以看', why: '第二批改判' }], () => 3000)
  const all = latestDigests(db, 10)
  assert.deepEqual(all.map((d) => d.id), [2, 1])
  assert.deepEqual(Object.keys(all[0]).sort(), ['created_at', 'headline', 'id', 'stats_json'])
  assert.equal(all[0].headline, '判了 1 条：值得看 0 · 可以看 1 · 不值当 0')
  assert.deepEqual(latestDigests(db, 1).map((d) => d.id), [2], 'limit 截住旧的')
  db.close()
})

test('库里还没有任何轮次时响亮失败：digests.run_id NOT NULL 兜住，整批不落', () => {
  const db = dbOf()
  const a = ins(db, { external_id: 'a' })
  // run_id 的公式是 lastRun()?.id ?? null，而 digests.run_id 是 NOT NULL（计划已取舍：
  // 不放宽、零迁移）——没有轮次就取不到 run_id，digest 写不进去，于是整批回滚。
  // 这条钉的是"响亮失败而不是写半批、也不伪造 run_id"；候选本来就来自摄取轮，
  // 正常流程到不了这个状态，真到了就该把失败摆到台面上。
  assert.throws(() => saveVerdicts(db, [{ id: a, tier: '值得看', why: 'x' }]), /run_id/)
  assert.equal(getItemById(db, a).status, 'new', '条目没被判掉——半批写入被 SAVEPOINT 退回')
  assert.equal(digestCount(db), 0)
  db.close()
})
