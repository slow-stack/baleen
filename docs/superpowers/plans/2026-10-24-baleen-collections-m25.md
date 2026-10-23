# 收藏夹（M2.5）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Baleen 加本地收藏夹——一个永远存在的默认夹 + 用户自建夹，收藏页成为面板第六格，抽屉里能一键把条目放进任意多个夹。

**Architecture:** 库侧两张新表 `folders` / `folder_items`（多对多，`ON DELETE CASCADE` 只删关系不删条目），store 提供六个纯 SQL 函数；宿主半新增四条路由（`/folders`、`/folder`、`/collect`、`/items?folder=`），全部只走"面板 → 宿主"这条写路径，不注册任何 agent 工具；客户端半新增 `views/collections.js`，并把 `Nav`/`VIEW_RENDER`/`VIEWS` 三处同步扩到六格。收藏不参与预筛、权重与判断轮（D17），并且让已收藏的条目豁免 `lib/runner.js` 的过期再归档（D15）。

**Tech Stack:** Node 24 ESM、`node:sqlite`（`DatabaseSync`）、`node --test`、零新增依赖（现有依赖只有 `yaml`）；客户端半是 loader bundle（`src/client/**` 经 `tools/build-client.mjs` 生成 `client.js`），纯对象节点树 + 装配层 `toElement()` 桥接 React。

**Spec:** `docs/superpowers/specs/2026-10-24-baleen-collections-design.md`（执行时两份一起读，本计划所有决定都从它论证）

## Global Constraints

- 零新增 npm 依赖。目前只允许 `yaml`；要加别的先停下来问用户。
- **收藏永远只写本机 sqlite**。代码里不得出现任何指向平台收藏/点赞/加夹接口的路径；`collect` 不得注册成 agent 工具（spec §8）。
- 测试只用 `node --test`，且必须写成 `node --test "test/*.test.js"`（Windows 下 `node --test test/` 会把目录当模块解析而报错）。
- **`client.js` 是生成产物，别手改**：改 `src/client/**` 后跑 `node tools/build-client.mjs`；`test/build.test.js` 会同时检查产物陈旧与"每个源文件都在 `PARTS` 里"。
- 生成时多个源文件内联进同一个 factory 作用域（只剥 `import`/`export` 行），**两个文件里的同名 `const` 会直接 `SyntaxError`**。节点工厂一律用 `src/client/vnode.js` 的 `vnode()`，格式化用 `src/client/format.js`，命中理由用 `src/client/match.js`。
- CSS 里**一个颜色字面量都不许**，只用 `test/css.test.js` 的 `HOST_TOKENS` 清单里那几个 `--dsw-alias-*`；`var()` 不写内联兜底。网格 `repeat(auto-fill, minmax(260px, 1fr))`，容器不许自己限宽。
- 三档词固定 `值得看 / 可以看 / 不值当`；`body_state` 六值固定；**`missing` 与 `burned_in` 不得合并**。
- 日志与诊断脱敏：不含用户名、不含家目录绝对路径、不含 token/cookie；`collect` 事件**只记夹 id 与动作，不记标题与 URL**。
- 名称规则逐字执行：夹名去首尾空白后 `1..40` 字符，**超长拒绝而不是截断**；重名 `409 name_taken`；删默认夹 `403 default_folder`（路由与 store 两层都拒）。
- 提交信息用中文，一个任务一次提交。任何 push / 发布 / 建仓动作都要先出草稿等用户批准。
- 视图渲染的是**假数据预览**才走 `tools/preview.mjs`；面板里不许出现看起来像真内容的假条目。

## 文件结构

| 文件 | 责任 | 本计划里的动作 |
|---|---|---|
| `lib/sql/items.sql` | 全部 DDL | 追加 `folders` + `folder_items` |
| `lib/store.js` | 所有 SQL 读写 | `migrate` 补默认夹；新增 `createFolder/renameFolder/deleteFolder/listFolders/setItemFolders/foldersOfItem/isCollected`；`listItems` 加 `folder` 参数 |
| `lib/runner.js:81` | 再归档点 | 加"在任意夹里就跳过"豁免 |
| `index.js` | 宿主半（路由 + 服务） | 四条新路由 + `baleen.folders()` 服务入口 |
| `src/client/view-api.js` | 面板取数层 | 加 `folders()` / `collect()` / `newFolder()` / `renameFolder()` / `deleteFolder()` |
| `src/client/views/collections.js` | 收藏页（新） | 六格之一的渲染器 |
| `src/client/views/drawer.js` | 抽屉 | 按钮改名 + 「收藏到…」多选 |
| `src/client/views/shell.js` | 导航 | `NAV_ITEMS` 加「收藏」 |
| `src/client/view-state.js` | 视图状态 | `VIEWS` 加 `'collections'`（筛选与当前夹复用已有的标量 `filter` 动作，不加新 action） |
| `src/client/_footer.txt` | 装配层 | `VIEW_RENDER` 加一格；按视图决定查询；持有"删除二次确认"的瞬时 state |
| `src/client/css.js` | 样式 | 新类名，零颜色 |
| `tools/build-client.mjs` | 生成 | `PARTS` 加 `views/collections.js` |
| `tools/preview.mjs` + `test/fixtures/preview-data.js` | 预览门 | 新增 `preview-collections.html`；抽屉页画多选；夹具加两个夹 |
| 测试 | — | 新建 `test/store-collections.test.js`、`test/views-collections.test.js`；追加 `test/runner.test.js`、`test/host-surface.test.js`、`test/views-drawer.test.js`、`test/client-boot.test.js`、`test/css.test.js`、`test/preview.test.js`、`test/view-state.test.js`、`test/view-api.test.js` |

**顺序有依赖**：Task 1→2→3 是库侧（后面全站在它们上面）；Task 4→5 是路由；Task 6 起是客户端。不要并行乱序。

---

## Task 1: 两张表与夹的 CRUD（含默认夹的诞生）

**Files:**
- Modify: `lib/sql/items.sql`（文件末尾追加）
- Modify: `lib/store.js:29-35`（`migrate`）与文件末尾（新增四个函数）
- Test: `test/store-collections.test.js`（新建）

**Interfaces:**
- Consumes: 无（这是第一个任务）
- Produces:
  - `createFolder(db, name, now = Date.now) -> { id, name, created_at, is_default: 0 }`；重名或名称非法时**抛** `Error('name_taken')` / `Error('bad_name')` / `Error('name_too_long')`
  - `renameFolder(db, id, name, now?) -> { id, name }`；改默认夹的名字允许，改不存在或非法名抛同错
  - `deleteFolder(db, id) -> { deleted: true, folder_id }`；`is_default=1` 时抛 `Error('default_folder')`；**级联只删 `folder_items` 关系**
  - `listFolders(db) -> [{ id, name, is_default, count }]`，排序 `is_default DESC, created_at ASC, id ASC`，`count` 含已归档条目

- [ ] **Step 1: 写失败的测试**

新建 `test/store-collections.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openStore, migrate, createFolder, renameFolder, deleteFolder, listFolders, setStatus
} from '../lib/store.js'

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

test('migrate 后恰好有一个默认夹，且重复 migrate 不会多出第二个', () => {
  const db = dbOf()
  assert.deepEqual(listFolders(db), [{ id: 1, name: '默认', is_default: 1, count: 0 }])
  migrate(db); migrate(db)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folders WHERE is_default = 1').get().n, 1)
  assert.equal(listFolders(db).length, 1)
  db.close()
})

test('老库补表：先建一张没有 folders 的库，migrate 之后默认夹自己长出来', () => {
  const { db } = openStore(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, external_id TEXT, kind TEXT, title TEXT, url TEXT, body_state TEXT, fetched_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT "new")')
  migrate(db)
  assert.equal(listFolders(db)[0].name, '默认')
  db.close()
})

test('建夹：名字进库、is_default 恒为 0、时间戳用传入的 now', () => {
  const db = dbOf()
  const f = createFolder(db, '公共管理', () => 2000)
  assert.equal(f.name, '公共管理')
  assert.equal(f.is_default, 0)
  assert.equal(f.created_at, 2000)
  assert.deepEqual(listFolders(db).map(x => x.name), ['默认', '公共管理'])
  db.close()
})

test('建夹的名字规则：空、纯空格、超长一律拒绝，且是拒绝而不是截断', () => {
  const db = dbOf()
  assert.throws(() => createFolder(db, ''), /bad_name/)
  assert.throws(() => createFolder(db, '   '), /bad_name/)
  assert.throws(() => createFolder(db, null), /bad_name/)
  assert.throws(() => createFolder(db, 'x'.repeat(41)), /name_too_long/)
  const ok = createFolder(db, '  ' + 'y'.repeat(40) + '  ')
  assert.equal(ok.name.length, 40, '首尾空白该去掉，中间保留')
  db.close()
})

test('重名拒绝，报错是 name_taken 而不是 SQLite 的 UNIQUE 约束原文', () => {
  const db = dbOf()
  createFolder(db, '考研')
  assert.throws(() => createFolder(db, '考研'), /name_taken/)
  assert.throws(() => createFolder(db, ' 考研 '), /name_taken/, '去空白后算同一个名字')
  assert.equal(listFolders(db).length, 2, '被拒的建夹不该留下半行')
  db.close()
})

test('改名：普通夹和默认夹都能改，改完 is_default 不变', () => {
  const db = dbOf()
  const f = createFolder(db, '旧名')
  renameFolder(db, f.id, '新名')
  assert.equal(listFolders(db).find(x => x.id === f.id).name, '新名')
  const d = renameFolder(db, 1, '我的收藏')
  assert.equal(d.name, '我的收藏')
  assert.equal(listFolders(db)[0].is_default, 1, '默认夹改名后仍排最前且还是默认')
  assert.throws(() => renameFolder(db, f.id, ''), /bad_name/)
  assert.throws(() => renameFolder(db, f.id, '我的收藏'), /name_taken/)
  assert.throws(() => renameFolder(db, 999, 'x'), /no_folder/)
  db.close()
})

test('删夹：只删收藏关系，条目一条都不动', () => {
  const db = dbOf()
  const f = createFolder(db, '要精读')
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 5)').run(f.id, a)
  deleteFolder(db, f.id)
  assert.equal(listFolders(db).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '级联没生效')
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(a), '条目被误删了')
  db.close()
})

test('默认夹删不掉，store 层就拒绝（不只靠 UI 不显示按钮）', () => {
  const db = dbOf()
  assert.throws(() => deleteFolder(db, 1), /default_folder/)
  assert.throws(() => deleteFolder(db, 999), /no_folder/)
  assert.equal(listFolders(db).length, 1)
  db.close()
})

test('count 含已归档条目：夹上写的数字必须等于点进去看到的条数', () => {
  const db = dbOf()
  const f = createFolder(db, '留档')
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const b = insRow(db, { external_id: 'b' }).lastInsertRowid
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 5)').run(f.id, a)
  db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, 6)').run(f.id, b)
  setStatus(db, b, 'archived', 'stale:20 天前')
  assert.equal(listFolders(db).find(x => x.id === f.id).count, 2)
  db.close()
})

test('排序不依赖时钟：created_at 相同的两个夹按 id 排，默认夹永远在最前', () => {
  const db = dbOf()
  const fixed = () => 5000
  const x = createFolder(db, 'X', fixed)
  const y = createFolder(db, 'Y', fixed)
  assert.deepEqual(listFolders(db).map(f2 => f2.id), [1, x.id, y.id])
  db.prepare('UPDATE folders SET created_at = 1 WHERE id = ?').run(y.id)
  assert.deepEqual(listFolders(db).map(f2 => f2.id), [1, y.id, x.id])
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/store-collections.test.js"`
Expected: FAIL — `does not provide an export named 'createFolder'`

- [ ] **Step 3: 追加 DDL**

在 `lib/sql/items.sql` 末尾接一段（缩进与现有表一致）：

```sql
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (folder_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_folder_items_item ON folder_items (item_id);
```

`ON DELETE CASCADE` 生效的前提是 `openStore` 里已有的 `PRAGMA foreign_keys = ON`（`lib/store.js:20`）——别在测试里另开一个不设该 PRAGMA 的连接，否则级联静默不生效，删夹会留下悬空关系。

- [ ] **Step 4: `migrate` 补默认夹**

把 `lib/store.js` 的 `migrate` 改成（新增最后三行；保持"重复执行不炸"）：

```js
export function migrate(db) {
  db.exec(DDL)
  const runCols = new Set(db.prepare('PRAGMA table_info(runs)').all().map((r) => r.name))
  if (!runCols.has('gaps_json')) db.exec('ALTER TABLE runs ADD COLUMN gaps_json TEXT')
  const itemCols = new Set(db.prepare('PRAGMA table_info(items)').all().map((r) => r.name))
  if (!itemCols.has('title_norm')) db.exec('ALTER TABLE items ADD COLUMN title_norm TEXT')
  // 默认夹是收藏功能的落点，必须"永远恰好一个"：只在缺席时补，不靠 UNIQUE 兜。
  if (!db.prepare('SELECT 1 FROM folders WHERE is_default = 1 LIMIT 1').get()) {
    db.prepare('INSERT INTO folders (name, created_at, is_default) VALUES (?, ?, 1)')
      .run('默认', Date.now())
  }
}
```

- [ ] **Step 5: 四个夹函数**

在 `lib/store.js` 末尾追加：

```js
/* ---------------- 收藏夹 ---------------- */

/** 名称规则的单一真相源：路由与 store 都靠它，别在路由里再抄一遍校验。 */
export function checkFolderName(raw) {
  if (typeof raw !== 'string') throw new Error('bad_name')
  const name = raw.trim()
  if (!name) throw new Error('bad_name')
  // 用码点而不是 .length，否则 emoji 名会被算成两个字符而误拒
  if ([...name].length > 40) throw new Error('name_too_long')
  return name
}

function folderRow(db, id) {
  const r = db.prepare('SELECT id, name, created_at, is_default FROM folders WHERE id = ?').get(id)
  if (!r) throw new Error('no_folder')
  return r
}

export function createFolder(db, raw, now = Date.now) {
  const name = checkFolderName(raw)
  try {
    const r = db.prepare('INSERT INTO folders (name, created_at, is_default) VALUES (?, ?, 0)')
      .run(name, now())
    return { id: Number(r.lastInsertRowid), name, created_at: now(), is_default: 0 }
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new Error('name_taken')
    throw e
  }
}

export function renameFolder(db, id, raw) {
  const cur = folderRow(db, id)
  const name = checkFolderName(raw)
  try {
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, cur.id)
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new Error('name_taken')
    throw e
  }
  return { id: cur.id, name }
}

export function deleteFolder(db, id) {
  const cur = folderRow(db, id)
  // 默认夹不可删是两层拒绝里的一层（另一层在 index.js 的路由）。删它只会让"随手一收"没落点。
  if (cur.is_default) throw new Error('default_folder')
  db.prepare('DELETE FROM folders WHERE id = ?').run(cur.id)
  return { deleted: true, folder_id: cur.id }
}

export function listFolders(db) {
  return db.prepare(`
    SELECT f.id, f.name, f.is_default,
           (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = f.id) AS count
    FROM folders f
    ORDER BY f.is_default DESC, f.created_at ASC, f.id ASC
  `).all().map((r) => ({ ...r, is_default: r.is_default ? 1 : 0 }))
}
```

`count` 用子查询而不是 `LEFT JOIN … GROUP BY`，是为了**不受条目状态影响**：收藏页查询不限状态（spec §5），夹上的数字必须等于点进去看到的条数，否则一定被当 bug 报。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test "test/store-collections.test.js" "test/store.test.js" "test/store-queries.test.js"`
Expected: PASS（新 10 条 + 原有 store 测试全绿；`migrate` 多了默认夹不能碰坏老断言）

- [ ] **Step 7: 提交**

```bash
git add lib/sql/items.sql lib/store.js test/store-collections.test.js
git commit -m "feat: 收藏夹两张表与夹的 CRUD（默认夹永远恰好一个）"
```

---

## Task 2: 收藏关系与"这条在哪些夹里"

**Files:**
- Modify: `lib/store.js`（`listItems` 的 `folder` 参数 + 三个新函数）
- Test: `test/store-collections.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `folders` / `folder_items` 表、`listFolders`
- Produces:
  - `setItemFolders(db, itemId, folderIds, now = Date.now) -> { item_id, folder_ids: number[] }` — **全量替换**；未知 id 抛 `Error('no_folder')`，条目不存在抛 `Error('no_item')`
  - `foldersOfItem(db, itemId) -> number[]` — 该条当前所属夹 id，按 `listFolders` 同序
  - `isCollected(db, itemId) -> boolean` — runner 的豁免用它
  - `listItems(db, { …, folder })` — `folder` 为整数时只取该夹里的条目，**不带状态过滤**

- [ ] **Step 1: 写失败的测试（追加到 `test/store-collections.test.js`）**

```js
import { setItemFolders, foldersOfItem, isCollected, listItems } from '../lib/store.js'

test('setItemFolders 是全量替换，重复提交同一集合不产生新行', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f1 = createFolder(db, '一').id
  const f2 = createFolder(db, '二').id
  setItemFolders(db, a, [f1, f2], () => 7000)
  setItemFolders(db, a, [f1, f2], () => 8000)
  assert.deepEqual(foldersOfItem(db, a).sort((x, y) => x - y), [f1, f2])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 2, '重复提交写出了多余的行')
  db.close()
})

test('提交空集合就是"全部移出"，不是把行删掉', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  setItemFolders(db, a, [])
  assert.deepEqual(foldersOfItem(db, a), [])
  assert.ok(db.prepare('SELECT id FROM items WHERE id = ?').get(a))
  db.close()
})

test('foldersOfItem 的顺序跟 listFolders 一致，收藏页两侧不会看到两种顺序', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const y = createFolder(db, 'Y', () => 300).id
  const z = createFolder(db, 'Z', () => 100).id
  setItemFolders(db, a, [y, z])
  assert.deepEqual(foldersOfItem(db, a), listFolders(db).filter((f) => f.id !== 1).map((f) => f.id))
  assert.deepEqual(foldersOfItem(db, a), [z, y], 'created_at 升序：Z 更早建')
  db.close()
})

test('未知夹与不存在条目分别报错，不静默写出悬空关系', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  assert.throws(() => setItemFolders(db, a, [f, 999]), /no_folder/)
  assert.deepEqual(foldersOfItem(db, a), [], '中途失败不该留下半套关系')
  assert.throws(() => setItemFolders(db, 9999, [f]), /no_item/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
  db.close()
})

test('isCollected：收过为真，移出后为假', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  assert.equal(isCollected(db, a), false)
  setItemFolders(db, a, [f])
  assert.equal(isCollected(db, a), true)
  setItemFolders(db, a, [])
  assert.equal(isCollected(db, a), false)
  db.close()
})

test('listItems 的 folder 按夹取，且归档的照样取得到', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const b = insRow(db, { external_id: 'b' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  setItemFolders(db, b, [f])
  setStatus(db, b, 'archived', 'stale:20 天前')
  assert.deepEqual(listItems(db, { folder: f }).map((r) => r.external_id).sort(), ['a', 'b'])
  assert.deepEqual(listItems(db, { folder: f, status: 'new' }).map((r) => r.external_id), ['a'])
  assert.deepEqual(listItems(db, { folder: 999 }), [])
  assert.equal(listItems(db, { folder: null }).length, 2, '不传 folder 时行为与从前完全一致')
  db.close()
})

test('删条目时收藏关系自己消失（FK 级联），不会留下悬空指针', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f = createFolder(db, '一').id
  setItemFolders(db, a, [f])
  db.prepare('DELETE FROM items WHERE id = ?').run(a)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
  assert.equal(listFolders(db).find((x) => x.id === f).count, 0)
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/store-collections.test.js"`
Expected: FAIL — `does not provide an export named 'setItemFolders'`

- [ ] **Step 3: 三个关系函数**

在 `lib/store.js` 的收藏夹段落下追加：

```js
/**
 * 全量替换一条条目的夹成员。一个事务：中途报错就整个回滚，
 * 否则会出现"移出了旧夹但没进新夹"，用户看到的条目凭空少了一个归属。
 */
export function setItemFolders(db, itemId, folderIds, now = Date.now) {
  const id = Number(itemId)
  if (!Number.isInteger(id)) throw new Error('no_item')
  if (!db.prepare('SELECT 1 FROM items WHERE id = ? LIMIT 1').get(id)) throw new Error('no_item')
  const raw = Array.isArray(folderIds) ? folderIds : []
  const wanted = [...new Set(raw.map((x) => Number(x)).filter((x) => Number.isInteger(x)))]
  for (const fid of wanted) {
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ? LIMIT 1').get(fid)) throw new Error('no_folder')
  }
  const at = now()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM folder_items WHERE item_id = ?').run(id)
    const ins = db.prepare('INSERT INTO folder_items (folder_id, item_id, added_at) VALUES (?, ?, ?)')
    for (const fid of wanted) ins.run(fid, id, at)
  })
  tx()
  return { item_id: id, folder_ids: wanted }
}

export function foldersOfItem(db, itemId) {
  return db.prepare(`
    SELECT fi.folder_id FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    WHERE fi.item_id = ?
    ORDER BY f.is_default DESC, f.created_at ASC, f.id ASC
  `).all(Number(itemId)).map((r) => r.folder_id)
}

/** runner 的归档豁免用这一条。EXISTS 而不是 COUNT(*)，取一个布尔就别数全表。 */
export function isCollected(db, itemId) {
  return Boolean(db.prepare('SELECT 1 FROM folder_items WHERE item_id = ? LIMIT 1').get(Number(itemId)))
}
```

- [ ] **Step 4: `listItems` 加 `folder`**

`lib/store.js` 的 `listItems` 现在长这样（Task 2 只加 `folder` 那两处）：

```js
export function listItems(db, { status = null, kind = null, tier = null, since = null, folder = null, limit = 100, offset = 0 } = {}) {
  const where = []
  const vals = []
  const statuses = (Array.isArray(status) ? status : String(status ?? '').split(','))
    .map((s) => String(s).trim()).filter(Boolean)
  if (statuses.length === 1) { where.push('status = ?'); vals.push(statuses[0]) }
  else if (statuses.length > 1) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    vals.push(...statuses)
  }
  if (kind) { where.push('kind = ?'); vals.push(kind) }
  if (tier) { where.push('verdict_tier = ?'); vals.push(tier) }
  if (since) { where.push('fetched_at >= ?'); vals.push(since) }
  // 收藏页取数：按夹走关系表。不带状态过滤——"我收过的不会凭空消失"是 D15 的承诺。
  if (folder != null && Number.isInteger(Number(folder))) {
    where.push('id IN (SELECT item_id FROM folder_items WHERE folder_id = ?)')
    vals.push(Number(folder))
  }
  return db.prepare(`SELECT ${ITEM_COLS} FROM items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY fetched_at DESC, id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test "test/store-collections.test.js" "test/store-queries.test.js"`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add lib/store.js test/store-collections.test.js
git commit -m "feat: 收藏关系全量替换（一个事务，避免归属半途丢失）"
```

## Task 3: 收藏豁免过期再归档

**Files:**
- Modify: `lib/runner.js:7`（import 加 `isCollected`）与 `lib/runner.js:79-87`（再归档点）
- Test: `test/runner.test.js`（追加两条）

**Interfaces:**
- Consumes: Task 2 的 `isCollected(db, itemId)`、`setItemFolders(db, itemId, folderIds)`
- Produces: 无新导出。行为契约（spec §5）：**已在任意夹里的条目，本轮 gate 失败不改 `archived`**；不在任何夹里的条目行为与现在逐字一致。

- [ ] **Step 1: 写失败的测试（追加到 `test/runner.test.js` 末尾）**

沿用文件里已有的 `pref` / `dbOf` / `rawOf` / `fakeAdapter`，只需在顶部 import 里补三个名字：

```js
import { openStore, migrate, listSources, getCursor, candidates, counts, createFolder, setItemFolders } from '../lib/store.js'
```

```js
const DAY = 86400000
const staleSource = () => ({ ...pref, sources: [{ id: 'slow', type: 'rss', url: 'https://e.com/slow', enabled: true, interval_min: 60, weight: 1 }] })
const twoStale = () => [
  rawOf('slow', { external_id: 'keep', title: 'DSH 的存货', published_at: 5000 - 100 * DAY }),
  rawOf('slow', { external_id: 'drop', title: 'DSH 的另一份存货', published_at: 5000 - 100 * DAY })
]
const statusOf = (db, eid) => db.prepare('SELECT status, archived_reason FROM items WHERE external_id = ?').get(eid)

test('收过的条目第二轮过期不归档；没收过的照旧归档（豁免不是关掉清理）', async () => {
  const db = dbOf()
  const p = staleSource()
  const A = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: A } })   // 首轮 backlog：两条都入库且不看过期
  const keepId = db.prepare("SELECT id FROM items WHERE external_id='keep'").get().id
  setItemFolders(db, keepId, [createFolder(db, '留档').id])

  const B = fakeAdapter('rss', { slow: { items: twoStale() } })
  const r = await runOnce({ db, pref: p, now: () => 5000 + 15 * DAY, adapters: { rss: B } })

  assert.equal(statusOf(db, 'keep').status, 'new', '收过的被误归档了')
  assert.equal(statusOf(db, 'drop').status, 'archived', '没收的那条该照旧归档')
  assert.match(statusOf(db, 'drop').archived_reason, /^stale:/)
  assert.equal(r.stats.archived, 1, '归档计数把被豁免的那条也算进去了')
})

test('移出夹之后，下一轮的过期清理照旧生效（钉住不等于永久免死）', async () => {
  const db = dbOf()
  const p = staleSource()
  const A = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000, adapters: { rss: A } })
  const keepId = db.prepare("SELECT id FROM items WHERE external_id='keep'").get().id
  const f = createFolder(db, '留档').id
  setItemFolders(db, keepId, [f])
  const B = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000 + 15 * DAY, adapters: { rss: B } })
  assert.equal(statusOf(db, 'keep').status, 'new')

  setItemFolders(db, keepId, [])
  const C = fakeAdapter('rss', { slow: { items: twoStale() } })
  await runOnce({ db, pref: p, now: () => 5000 + 16 * DAY, adapters: { rss: C } })
  assert.equal(statusOf(db, 'keep').status, 'archived', '移出后还免归档，说明豁免读的不是当前状态')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/runner.test.js"`
Expected: FAIL — 第一条里 `keep` 的 status 是 `'archived'`（豁免还没实现）

- [ ] **Step 3: 在再归档点加豁免**

`lib/runner.js:7` 的 import 补一个名字：

```js
import { createRun, finishRun, setCursor, setSourceResult, setStatus, isCollected } from './store.js'
```

`lib/runner.js:79-87` 那段改成：

```js
      const g = gate(draft, effPref, now, { backlog })
      if (!g.pass) {
        // 收藏 = 钉住（D15）：收过的条目这轮没过闸也不改归档，且每次都现读关系表，
        // 所以移出夹之后下一轮照旧被清理——豁免不是给条目发免死牌。
        // duplicate 那条路径不动：去重归档的是多出来的冗余副本，留下的本来就是被收的那一份。
        if (put.action !== 'duplicate' && !isCollected(db, put.id)) {
          setStatus(db, put.id, 'archived', `${g.reason}:${g.detail ?? ''}`)
          local.archived++
          gapLog.push({ reason: g.reason, detail: g.detail })
        }
        continue
      }
```

注意 `continue` 保持在豁免之外：被豁免的条目**仍然不是候选**（不该因为它被收藏了就重新送去判断、白烧预算）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/runner.test.js" "test/prefilter.test.js" "test/dedup.test.js"`
Expected: PASS（原有断言一条都不许放松）

- [ ] **Step 5: 提交**

```bash
git add lib/runner.js test/runner.test.js
git commit -m "feat: 收过的条目豁免过期再归档（移出夹后下一轮照旧清理）"
```

---

## Task 4: 宿主路由 `/folders` 与 `/folder`

**Files:**
- Modify: `index.js:3`（import）、`index.js:16` 附近（动作白名单与错误映射）、`index.js:92-130`（`handleApi`）
- Test: `test/host-surface.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `createFolder / renameFolder / deleteFolder / listFolders / checkFolderName`
- Produces:
  - `GET /api/dsh-baleen/folders` → `{ ok: true, folders: [{ id, name, is_default, count }] }`
  - `POST /api/dsh-baleen/folder` 请求 `{ action: 'create'|'rename'|'delete', name?, id? }`
    → 成功 `{ ok: true, folder?, folders }`；失败 `{ ok: false, error }` + 状态码：`400 bad_name` / `400 name_too_long` / `400 unknown_action` / `404 no_folder` / `409 name_taken` / `403 default_folder`
  - 服务入口 `baleen.folders()`（给别的插件用，形状同 `GET /folders`）

- [ ] **Step 1: 写失败的测试（追加到 `test/host-surface.test.js`）**

沿用文件里已有的 `freshHome()` / `makeCtx(home)` / `fakeRes()` / `bodyOf(o)`：

```js
const apiOf = async (home) => {
  const ctx = makeCtx(home)
  const { apply } = await import('../index.js')
  const baleen = apply(ctx, { now: () => 1000, setInterval: ctx.setInterval, clearInterval: ctx.clearInterval })
  return { h: ctx.registered[0].handler, baleen, ctx }
}

test('GET /folders 至少带回那个删不掉的默认夹', async () => {
  const { h } = await apiOf(freshHome())
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folders', method: 'GET' }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.code, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.folders, [{ id: 1, name: '默认', is_default: 1, count: 0 }])
})

test('POST /folder 建夹：成功就回整个列表', async () => {
  const { h } = await apiOf(freshHome())
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '公共管理' }) }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.code, 200)
  assert.equal(body.folder.name, '公共管理')
  assert.equal(body.folder.is_default, 0)
  assert.deepEqual(body.folders.map(f => f.name), ['默认', '公共管理'])
})

test('建夹的失败路径给的是人话状态码，不是 500', async () => {
  const { h } = await apiOf(freshHome())
  const cases = [
    [{ action: 'create', name: '  ' }, 400, 'bad_name'],
    [{ action: 'create', name: 'x'.repeat(41) }, 400, 'name_too_long'],
    [{ action: 'create', name: '默认' }, 409, 'name_taken'],
    [{ action: 'nope' }, 400, 'unknown_action'],
    [{ action: 'delete', id: 1 }, 403, 'default_folder'],
    [{ action: 'delete', id: 999 }, 404, 'no_folder'],
    [{ action: 'rename', id: 999, name: 'x' }, 404, 'no_folder'],
    [{}, 400, 'unknown_action'],
    [{ action: 'create' }, 400, 'bad_name']
  ]
  for (const [payload, code, error] of cases) {
    const res = fakeRes()
    await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf(payload) }, res)
    assert.equal(res.code, code, JSON.stringify(payload) + ' 的状态码不对')
    assert.equal(JSON.parse(res.body).error, error, JSON.stringify(payload))
    assert.equal(JSON.parse(res.body).ok, false)
  }
})

test('删自建夹：条目一条不少，夹列表变短', async () => {
  const home = freshHome()
  const { h, baleen } = await apiOf(home)
  const created = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '要精读' }) }, created)
  const fid = JSON.parse(created.body).folder.id
  baleen.db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, body_state, fetched_at, status)
    VALUES ('s1', 'e1', 'article', 't', 'https://e.com/1', 'full', 1000, 'new')`).run()
  const iid = baleen.db.prepare('SELECT id FROM items').get().id
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [fid] }) }, fakeRes())
  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: fid }) }, del)
  assert.equal(del.code, 200)
  assert.equal(JSON.parse(del.body).folders.length, 1)
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM items').get().n, 1, '删夹把条目删了')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0)
})

test('folder 事件进日志时只有动作与夹 id，不含夹名也不含标题', async () => {
  const home = freshHome()
  process.env.BALEEN_HOME = home
  const { h } = await apiOf(home)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '考研专业课' }) }, res)
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const logs = fsMod.readdirSync(home).filter((f) => f.endsWith('.log'))
  const blob = logs.map((f) => fsMod.readFileSync(pathMod.join(home, f), 'utf8')).join('\n')
  assert.match(blob, /folder/, '建夹没记日志')
  assert.doesNotMatch(blob, /考研专业课/, '日志里出现了夹名')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/host-surface.test.js"`
Expected: FAIL — `/folders` 走 404（`no such route`）

- [ ] **Step 3: 路由实现**

`index.js:3` 的 store import 补上：

```js
import {
  openStore, migrate, counts, listItems, listSources, lastRun, getCursor, markFeedback,
  listFolders, createFolder, renameFolder, deleteFolder, checkFolderName
} from './lib/store.js'
```

`index.js:16` 的 `ALLOWED_ACTIONS` 下面加两张表：

```js
/** 夹操作是白名单而不是 if 链：新加动作时漏了枚举就直接 400，不会悄悄走进某个分支 */
const FOLDER_ACTIONS = new Set(['create', 'rename', 'delete'])

/** store 抛的是短码（name_taken / bad_name / …），这里只负责翻成 HTTP 语义 */
const FOLDER_ERRORS = { name_taken: 409, name_too_long: 400, bad_name: 400, no_folder: 404, default_folder: 403 }
```

`handleApi` 里，在 `if (sub === '/run' …)` 之前插入两条：

```js
      if (sub === '/folders' && req.method === 'GET') {
        return json(res, 200, { ok: true, folders: listFolders(db) })
      }
      if (sub === '/folder' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') || {}
        if (!FOLDER_ACTIONS.has(body.action)) return json(res, 400, { ok: false, error: 'unknown_action' })
        try {
          let folder = null
          if (body.action === 'create') folder = createFolder(db, body.name, now)
          else if (body.action === 'rename') folder = renameFolder(db, Number(body.id), body.name)
          else deleteFolder(db, Number(body.id))
          // 夹名可能带个人色彩（"考研专业课"），日志只记动作与 id。
          log({ level: 'info', event: 'folder', detail: `${body.action} #${body.id ?? folder?.id ?? ''}` })
          return json(res, 200, { ok: true, folder, folders: listFolders(db) })
        } catch (e) {
          const code = FOLDER_ERRORS[String(e?.message)] ?? 500
          if (code === 500) log({ level: 'error', event: 'folder_failed', detail: `${body.action}: ${String(e?.message).slice(0, 60)}` })
          return json(res, code, { ok: false, error: code === 500 ? 'internal' : String(e?.message) })
        }
      }
```

`checkFolderName` 这一版先在 store 层用到即可（`createFolder` 内部调它）；import 列表里带上是为了 Task 5 的 `/collect` 复用同一个名称校验。**如果 Task 5 最终没用到，就把这个名字从 import 里删掉**——留个没用到的 import 会被下一轮误读成"collect 也校验名字"。

`baleen` 服务入口加一行（在 `state,` 附近）：

```js
    folders: () => listFolders(db),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/host-surface.test.js"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add index.js test/host-surface.test.js
git commit -m "feat: 夹的建改名删路由（默认夹 403、重名 409，日志不含夹名）"
```

---

## Task 5: `/collect`（含 `new_folder` 原子）与 `/items?folder=`

**Files:**
- Modify: `index.js`（`/items` 分支加 `folder` 参数；新增 `/collect` 分支）、`lib/store.js`（`itemsForFolders` 读函数）
- Test: `test/host-surface.test.js`（追加）、`test/store-collections.test.js`（追加）

**Interfaces:**
- Consumes: Task 1-4 的全部 store 函数与两张表
- Produces:
  - `itemsWithFolders(db, opts) -> Array<item & { folders: number[], folder_names: string[] }>` — 收藏页取数用；`opts` 与 `listItems` 同形（含 `folder`）
  - `POST /api/dsh-baleen/collect` 请求 `{ item_id, folder_ids?, new_folder? }` → 成功 `{ ok: true, item_id, folder_ids, folders }`；失败 `{ ok: false, error }` + 状态码：`400 bad_payload` / `400 bad_name` / `400 name_too_long` / `404 no_item` / `410 folder_gone` + `missing: [id]`
  - `GET /api/dsh-baleen/items?folder=<id>` — 与现有 `/items` 同一分支，只是多了 `folder`
  - 服务入口 `baleen.collect(itemId, folderIds, newFolderName?)`

- [ ] **Step 1: 写失败的测试（追加到 `test/store-collections.test.js`）**

```js
import { itemsWithFolders } from '../lib/store.js'

test('itemsWithFolders 每条都带 folders 与 folder_names，收藏页一次取数就够', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const f1 = createFolder(db, '一').id
  const f2 = createFolder(db, '二').id
  setItemFolders(db, a, [f1, f2])
  const rows = itemsWithFolders(db, { folder: f1 })
  assert.equal(rows.length, 1)
  assert.deepEqual([...rows[0].folders].sort((x, y) => x - y), [f1, f2].sort((x, y) => x - y))
  assert.deepEqual(rows[0].folder_names.length, 2)
  assert.equal(typeof rows[0].title, 'string')
})

test('itemsWithFolders 的 folders 一定按 listFolders 的顺序，不是按加入时间', () => {
  const db = dbOf()
  const a = insRow(db, { external_id: 'a' }).lastInsertRowid
  const z = createFolder(db, 'Z', () => 100).id
  const y = createFolder(db, 'Y', () => 300).id
  setItemFolders(db, a, [y, z])
  assert.deepEqual(itemsWithFolders(db, {})[0].folders, foldersOfItem(db, a))
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/store-collections.test.js"`
Expected: FAIL — `does not provide an export named 'itemsWithFolders'`

- [ ] **Step 3: `itemsWithFolders`**

`lib/store.js` 的收藏段落追加（夹名单一次取，别在映射里逐条查，否则 200 条就是 200 次查询）：

```js
/**
 * 收藏页的取数：条目 + 它所属的夹 id + 夹名。
 * 面板要在一趟请求里拿到"这条还在哪些夹里"，否则卡片上那一行只能留空——
 * 而多夹归属不写出来，用户移出时根本不知道自己顺手动了哪个夹。
 */
export function itemsWithFolders(db, opts = {}) {
  const rows = listItems(db, opts)
  if (!rows.length) return []
  const names = new Map(listFolders(db).map((f) => [f.id, f.name]))
  const order = [...names.keys()]
  const pairs = db.prepare('SELECT item_id, folder_id FROM folder_items').all()
  const byItem = new Map()
  for (const p of pairs) {
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, [])
    byItem.get(p.item_id).push(p.folder_id)
  }
  return rows.map((r) => {
    const ids = (byItem.get(r.id) ?? []).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return { ...r, folders: ids, folder_names: ids.map((id) => names.get(id)) }
  })
}
```

- [ ] **Step 4: 写路由失败的测试（追加到 `test/host-surface.test.js`）**

```js
const seedItem = (baleen, over = {}) => {
  baleen.db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, body_state, fetched_at, status)
    VALUES ('s1', @external_id, 'article', 't', 'https://e.com/x', 'full', 1000, 'new')`)
    .run({ external_id: over.external_id ?? 'e1' })
  return baleen.db.prepare('SELECT id FROM items ORDER BY id DESC LIMIT 1').get().id
}

test('POST /collect 是全量替换，重复提交同一集合结果不变', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '一' }) }, mk)
  const oneId = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  const r1 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [oneId] }) }, r1)
  assert.equal(r1.code, 200)
  assert.deepEqual(JSON.parse(r1.body).folder_ids, [oneId])
  const r2 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [oneId, oneId] }) }, r2)
  assert.deepEqual(JSON.parse(r2.body).folder_ids, [oneId], '重复 id 没去重')
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 1)
})

test('/collect 的 new_folder 与收藏在同一次请求里做完，不留空夹', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const iid = seedItem(baleen)
  const res = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [], new_folder: '新起的' }) }, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(res.body)
  const created = body.folders.find((f) => f.name === '新起的')
  assert.ok(created, '夹没建成')
  assert.deepEqual(body.folder_ids, [created.id], '夹建好了但条目没进去')
})

test('/collect 的失败路径：夹没了、条目没了、载荷坏了各说各话', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '二' }) }, mk)
  const goneId = JSON.parse(mk.body).folder.id
  const iid = seedItem(baleen)
  const r1 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [goneId, 999] }) }, r1)
  assert.equal(r1.code, 410)
  assert.deepEqual(JSON.parse(r1.body).missing, [goneId, 999])
  assert.equal(baleen.db.prepare('SELECT COUNT(*) n FROM folder_items').get().n, 0, '失败的那次写出了半套关系')

  const r2 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: 99999, folder_ids: [goneId] }) }, r2)
  assert.equal(r2.code, 404)
  assert.equal(JSON.parse(r2.body).error, 'no_item')

  const r3 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid }) }, r3)
  assert.equal(r3.code, 400)
  assert.equal(JSON.parse(r3.body).error, 'bad_payload')

  const r4 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf('坏掉的') }, r4)
  assert.equal(r4.code, 400)

  const del = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'delete', id: goneId }) }, del)
  const r5 = fakeRes()
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: iid, folder_ids: [], new_folder: '  ' }) }, r5)
  assert.equal(r5.code, 400)
  assert.equal(JSON.parse(r5.body).error, 'bad_name')
})

test('GET /items?folder= 取该夹条目并带上所属夹，归档的也列得出', async () => {
  const { h, baleen } = await apiOf(freshHome())
  const mk = fakeRes()
  await h({ url: '/api/dsh-baleen/folder', method: 'POST', ...bodyOf({ action: 'create', name: '三' }) }, mk)
  const fid = JSON.parse(mk.body).folder.id
  const keep = seedItem(baleen, { external_id: 'keep' })
  const other = seedItem(baleen, { external_id: 'other' })
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: keep, folder_ids: [fid] }) }, fakeRes())
  await h({ url: '/api/dsh-baleen/collect', method: 'POST', ...bodyOf({ item_id: other, folder_ids: [fid] }) }, fakeRes())
  baleen.db.prepare("UPDATE items SET status='archived', archived_reason='stale:20 天前' WHERE id=?").run(other)
  const res = fakeRes()
  await h({ url: `/api/dsh-baleen/items?folder=${fid}`, method: 'GET' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.items.length, 2, '归档的条目从收藏页消失了')
  assert.deepEqual(body.items.map((i) => i.folders).sort(), [[fid], [fid]])
  assert.deepEqual(body.items[0].folder_names, ['三'])
})

test('collect 不注册成 agent 工具：宿主半的 inject 仍然只有 webServer', async () => {
  const host = await import('../index.js')
  assert.deepEqual(host.inject, ['webServer'])
})
```

- [ ] **Step 5: 路由实现**

`index.js` 的 store import 追加 `setItemFolders, itemsWithFolders`（并删掉 Task 4 里预告可能不用的 `checkFolderName` —— `/collect` 用 `createFolder` 自带的校验即可）。

`/items` 分支改成带 `folder`，并新增 `/collect`：

```js
      if (sub === '/items' && req.method === 'GET') {
        const q = url.searchParams
        const folderRaw = q.get('folder')
        const opts = {
          status: q.get('status') || null, kind: q.get('kind') || null, tier: q.get('tier') || null,
          limit: num(q.get('limit'), 100, 500), offset: num(q.get('offset'), 0, 100000)
        }
        if (folderRaw != null && Number.isInteger(Number(folderRaw))) opts.folder = Number(folderRaw)
        // 收藏页要一次拿到"这条还在哪些夹里"；其余视图沿用不带夹信息的取数
        return json(res, 200, { ok: true, items: opts.folder == null ? listItems(db, opts) : itemsWithFolders(db, opts) })
      }
      if (sub === '/collect' && req.method === 'POST') {
        let body
        try { body = JSON.parse((await readBody(req)) || '{}') || {} } catch { return json(res, 400, { ok: false, error: 'bad_payload' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad_payload' })
        const itemId = Number(body.item_id)
        if (!Number.isInteger(itemId)) return json(res, 400, { ok: false, error: 'bad_payload' })
        const wanted = Array.isArray(body.folder_ids) ? body.folder_ids.map((x) => Number(x)) : null
        if (wanted == null && typeof body.new_folder !== 'string') return json(res, 400, { ok: false, error: 'bad_payload' })
        const missing = wanted === null ? [] : wanted.filter((id) => !Number.isInteger(id) || !db.prepare('SELECT 1 FROM folders WHERE id = ? LIMIT 1').get(id))
        if (missing.length) {
          // 面板上一秒看的夹可能已经被另一格删掉。说清是哪几个，别静默丢掉那部分意图。
          return json(res, 410, { ok: false, error: 'folder_gone', missing })
        }
        try {
          let created = null
          if (typeof body.new_folder === 'string' && body.new_folder.trim()) {
            created = createFolder(db, body.new_folder, now)
          }
          const ids = [...new Set([...(wanted ?? []), ...(created ? [created.id] : [])])]
          const resOf = setItemFolders(db, itemId, ids, now)
          log({ level: 'info', event: 'collect', detail: `item#${itemId} → ${ids.length} 个夹` })
          return json(res, 200, { ok: true, item_id: itemId, folder_ids: resOf.folder_ids, folders: listFolders(db) })
        } catch (e) {
          const code = FOLDER_ERRORS[String(e?.message)] ?? (String(e?.message) === 'no_item' ? 404 : 500)
          if (code === 500) log({ level: 'error', event: 'collect_failed', detail: String(e?.message).slice(0, 60) })
          return json(res, code, { ok: false, error: code === 500 ? 'internal' : String(e?.message) })
        }
      }
```

服务入口 `baleen` 加：

```js
    collect: (itemId, folderIds, newFolderName) => setItemFolders(db, itemId, folderIds, now),
    foldersOf: (itemId) => foldersOfItem(db, itemId),
```

`newFolderName` 这个参数如果最终没被任何调用方用到，就从签名里去掉（**别留用不上的参数**）——`/collect` 路由自己会先 `createFolder` 再 `setItemFolders`，不需要服务入口代劳。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test "test/host-surface.test.js" "test/store-collections.test.js" "test/store-queries.test.js"`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add index.js lib/store.js test/host-surface.test.js test/store-collections.test.js
git commit -m "feat: /collect 全量替换与 new_folder 原子落点，收藏页取数带所属夹"
```

## Task 6: 面板取数层接上收藏，视图状态扩到六格

**Files:**
- Modify: `src/client/view-api.js`（新增 `post` 私有helper + 四个方法）
- Modify: `src/client/view-state.js:6`（`VIEWS`）、`src/client/views/shell.js:11`（`NAV_ITEMS`）
- Test: `test/view-api.test.js`（追加）、`test/view-state.test.js`（追加）、`test/shell.test.js`（追加）

**Interfaces:**
- Consumes: Task 4/5 的四条路由
- Produces（`createApi()` 返回值上）：
  - `folders() -> Promise<{ ok, stale, data: { folders } | null }>` — **不写共享快照**（原因见 Step 3 注释）
  - `collect(itemId, folderIds, newFolder?) -> Promise<{ ok, error?, missing?, data? }>`
  - `folderOp(action, { id?, name? }) -> Promise<{ ok, error?, data? }>`
  - `VIEWS = ['today', 'video', 'article', 'collections', 'digest', 'library']`
  - `NAV_ITEMS` 六项，`collections` 的标签是「收藏」

- [ ] **Step 1: 写失败的测试（追加到 `test/view-api.test.js`）**

沿用文件里已有的假 fetch/假 storage 形状（`createApi({ fetch, storage })`）：

```js
const recorder = (responses = {}) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const key = String(url).replace('/api/dsh-baleen', '')
    const r = responses[key.split('?')[0]] ?? { code: 200, json: { ok: true } }
    return { ok: r.code < 400, status: r.code, json: async () => r.json }
  }
  return { calls, fetchImpl }
}

test('collect 发的是 item_id + folder_ids，没给 new_folder 时这个键根本不出现在载荷里', async () => {
  const { calls, fetchImpl } = recorder({ '/collect': { code: 200, json: { ok: true, folder_ids: [2] } } })
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  const out = await api.collect(7, [2])
  assert.equal(out.ok, true)
  assert.deepEqual(JSON.parse(calls[0].init.body), { item_id: 7, folder_ids: [2] })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
})

test('collect 带上 new_folder（非空字符串才带）', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  await api.collect(7, [], '新夹')
  assert.deepEqual(JSON.parse(calls[0].init.body), { item_id: 7, folder_ids: [], new_folder: '新夹' })
  await api.collect(7, [], '   ')
  assert.equal(JSON.parse(calls[1].init.body).new_folder, undefined, '全空白的夹名不该发出去')
})

test('folder_gone 的 410 要带着是哪几个夹回来——这是收藏唯一的"半途失败"路径', async () => {
  const { fetchImpl } = recorder({ '/collect': { code: 410, json: { ok: false, error: 'folder_gone', missing: [3, 5] } } })
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  const out = await api.collect(7, [3, 5])
  assert.equal(out.ok, false)
  assert.equal(out.error, 'folder_gone')
  assert.deepEqual(out.missing, [3, 5])
})

test('folderOp 三种动作都发对载荷', async () => {
  const { calls, fetchImpl } = recorder()
  const api = createApi({ fetch: fetchImpl, storage: memStorage() })
  await api.folderOp('create', { name: '一' })
  await api.folderOp('rename', { id: 2, name: '二' })
  await api.folderOp('delete', { id: 2 })
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'create', name: '一' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'rename', id: 2, name: '二' })
  assert.deepEqual(JSON.parse(calls[2].init.body), { action: 'delete', id: 2 })
})

test('folders() 读得到，但不把共享快照盖掉（否则下一次 state 失败会拿到夹列表）', async () => {
  const storage = memStorage()
  const { fetchImpl } = recorder({ '/folders': { code: 200, json: { ok: true, folders: [{ id: 1, name: '默认', is_default: 1, count: 0 }] } } })
  const api = createApi({ fetch: fetchImpl, storage })
  const out = await api.folders()
  assert.deepEqual(out.data.folders[0].name, '默认')
  assert.equal(storage.getItem(SNAPSHOT_KEY), null, 'folders 写进了共享快照')
})

test('路由整个缺席时 folders() 报 stale 且 data 为 null，由渲染层出"读不到夹"', async () => {
  const api = createApi({ fetch: async () => { throw new Error('fetch failed') }, storage: memStorage() })
  const out = await api.folders()
  assert.equal(out.ok, false)
  assert.equal(out.stale, true)
  assert.equal(out.data, null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/view-api.test.js"`
Expected: FAIL — `api.collect is not a function`

- [ ] **Step 3: 实现四个方法**

`src/client/view-api.js` 里，在 `createApi` 内部的 `get` 函数下面加一个 `post`（**不动 `call`/`get`**，避免改坏现有 GET 的快照回落语义）：

```js
  /**
   * 写请求专用。与 get() 的分别：4xx/5xx 也要把响应体读出来——
   * folder_gone 带的是"哪几个夹没了"，丢了就等于面板只能说"没记上"，
   * 而用户真正需要知道的是那个夹已经被删了，换个夹再收一次。
   */
  async function post(urlPath, payload) {
    try {
      const res = await fetchImpl(API_BASE + urlPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const status = (res && res.status) ?? 0
      let json = null
      try { json = res && await res.json() } catch { json = null }
      if (res && res.ok === false) {
        return {
          ok: false,
          error: (json && json.error) || ('HTTP ' + status),
          missing: (json && json.missing) || undefined,
          data: json
        }
      }
      return { ok: true, stale: false, data: json }
    } catch (e) {
      return { ok: false, stale: true, error: String((e && e.message) || e), data: null }
    }
  }
```

返回值对象里追加四个方法（`folders` **故意不调用 `write()`**：`SNAPSHOT_KEY` 那份快照是给顶栏/状态区兜底用的，让夹列表把它盖掉会让下一次 `state()` 失败时读出错误形状的数据）：

```js
    folders: async () => {
      try {
        const res = await fetchImpl(API_BASE + '/folders', { cache: 'no-store' })
        if (!res || res.ok === false) return { ok: false, stale: true, data: null }
        return { ok: true, stale: false, data: await res.json() }
      } catch { return { ok: false, stale: true, data: null } }
    },
    collect: (itemId, folderIds, newFolder) => post('/collect', {
      item_id: itemId,
      folder_ids: Array.isArray(folderIds) ? folderIds : [],
      ...(typeof newFolder === 'string' && newFolder.trim() ? { new_folder: newFolder.trim() } : {})
    }),
    folderOp: (action, { id, name } = {}) => post('/folder', { action, ...(id != null ? { id } : {}), ...(name != null ? { name } : {}) }),
```

- [ ] **Step 4: 六格状态与导航**

`src/client/view-state.js` 的 `VIEWS` 与 `src/client/views/shell.js` 的 `NAV_ITEMS` 各加一格，位置在 `article` 之后、`digest` 之前：

```js
export const VIEWS = ['today', 'video', 'article', 'collections', 'digest', 'library']
```

```js
export const NAV_ITEMS = [['today', '今天'], ['video', '视频'], ['article', '文章'], ['collections', '收藏'], ['digest', '汇报'], ['library', '库']]
```

收藏页的"当前看的是哪个夹"**复用已有的标量 `filter` 动作**（`{type:'filter', view:'collections', key:'folder', value:<id>}`），不新增 reducer action；二次确认与"新建夹名"是装配层的瞬时 state（Task 8），也不进 reducer。

- [ ] **Step 5: 追加状态与导航的测试**

`test/view-state.test.js` 第一条改断六格，并在 `test/shell.test.js` 里加一条同序断言：

```js
test('六个视图固定，落点是今天', () => {
  assert.deepEqual(VIEWS, ['today', 'video', 'article', 'collections', 'digest', 'library'])
  assert.equal(initialView().view, 'today')
})
```

```js
test('NAV_ITEMS 与 VIEWS 一字不差，标签也不许漂', () => {
  assert.deepEqual(NAV_ITEMS.map(([id]) => id), [...VIEWS])
  assert.deepEqual(NAV_ITEMS.map(([, l]) => l), ['今天', '视频', '文章', '收藏', '汇报', '库'])
})
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test "test/view-api.test.js" "test/view-state.test.js" "test/shell.test.js"`
Expected: PASS — **此时 `test/client-boot.test.js` 的"六格三处同名"守卫会红**，因为 `VIEW_RENDER` 还没有 `collections`。这是预期的：那条守卫的意义就是拦住"加了一格但忘了渲染器"。红着进 Task 7 可以，但**不许**为了让它绿而删掉断言。

- [ ] **Step 7: 提交**

```bash
git add src/client/view-api.js src/client/view-state.js src/client/views/shell.js test/view-api.test.js test/view-state.test.js test/shell.test.js
git commit -m "feat: 取数层接上收藏（410 带回复是哪几个夹没了），导航扩到六格"
```

---

## Task 7: 抽屉改名「这源多来点」+「收藏到…」多选

**Files:**
- Modify: `src/client/views/drawer.js`（按钮文案、`feedbackHint`、新增收藏区块）
- Modify: `src/client/_footer.txt`（把 `folders` 与 `api` 传进抽屉）
- Test: `test/views-drawer.test.js`（改名断言 + 追加）
- Modify: `docs/superpowers/specs/2026-10-23-baleen-design.md:233`（两个按钮语义的原文措辞）

**Interfaces:**
- Consumes: Task 6 的 `api.collect / api.folders`
- Produces:
  - `Drawer({ item, api, onClose, onDone, note, folders, collecting })` — `folders` 是 `[{ id, name, is_default, count }]`，`item.folders` 是该条当前所属夹 id 数组
  - `feedbackHint('save')` 的文案以「这源多来点」开头
  - `collectSetOf(item, folders, toggleId)` 导出为纯函数：返回勾掉/勾上 `toggleId` 之后的夹 id 集合（按 `folders` 顺序）

- [ ] **Step 1: 写失败的测试**

先把 `test/views-drawer.test.js` 里两处旧断言换掉（撞名的正主）：

```js
// 原来：assert.match(t, /收藏/)  —— 现在"收藏"指的是收藏夹，语义已经换了
assert.match(t, /这源多来点/)
// 原来：await btn(tree, '收藏').props.onClick()
await btn(tree, '这源多来点').props.onClick()
```

再追加：

```js
import { Drawer, boundaryNote, feedbackHint, collectSetOf } from '../src/client/views/drawer.js'

const FOLDERS = [
  { id: 1, name: '默认', is_default: 1, count: 0 },
  { id: 2, name: '公共管理', is_default: 0, count: 3 },
  { id: 3, name: '要精读', is_default: 0, count: 1 }
]

test('「收藏到…」把这条当前所属的夹回填成勾选', () => {
  const tree = Drawer({ item: item({ folders: [2] }), api: {}, folders: FOLDERS })
  const boxes = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')
  assert.equal(boxes.length, 3)
  assert.deepEqual(boxes.map((b) => Boolean(b.props.checked)), [false, true, false])
  assert.deepEqual(boxes.map((b) => b.props['aria-label']), ['放进：默认', '放进：公共管理', '放进：要精读'])
})

test('点一个夹名就是立刻放进，提交的是"当前集合 + 这一个"', async () => {
  const sent = []
  const api = { collect: async (id, folderIds) => { sent.push([id, folderIds]); return { ok: true, data: { folder_ids: folderIds } } } }
  const tree = Drawer({ item: item({ folders: [2] }), api, folders: FOLDERS })
  const box = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[0]
  await box.props.onChange({ target: { checked: true } })
  assert.deepEqual(sent, [[1, [2, 1]]], '放进的顺序该跟夹列表一致')
})

test('再点一次是移出，集合里减掉那一个', async () => {
  const sent = []
  const api = { collect: async (id, folderIds) => { sent.push(folderIds); return { ok: true } } }
  const tree = Drawer({ item: item({ folders: [2, 3] }), api, folders: FOLDERS })
  const box = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[1]
  await box.props.onChange({ target: { checked: false } })
  assert.deepEqual(sent, [[3]])
})

test('collectSetOf 不靠夹列表的顺序反推，条目里多出来的未知夹 id 要保留', () => {
  assert.deepEqual(collectSetOf({ folders: [9] }, FOLDERS, 1, true), [9, 1])
  assert.deepEqual(collectSetOf({ folders: [1, 9] }, FOLDERS, 1, false), [9])
  assert.deepEqual(collectSetOf(null, FOLDERS, 2, true), [2])
})

test('没有夹列表时（路由缺席）说读不到，不给一组空勾', () => {
  const t = text(Drawer({ item: item(), api: {}, folders: [] }))
  assert.match(t, /读不到夹/)
  assert.doesNotMatch(t, /放进：/)
})

test('new_folder 那行：空白名不发，发了就带上', async () => {
  const sent = []
  const api = { collect: async (id, folderIds, nf) => { sent.push([id, folderIds, nf]); return { ok: true } } }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS })
  const row = findAll(tree, 'bl-newfolder')[0]
  await row.children.find((n) => n.type === 'button').props.onClick({ })
  assert.deepEqual(sent, [], '没填名字不该发请求')
})

test('collect 失败的回显分两种：没记上 / 夹已经不在了', async () => {
  const done = []
  const api = { collect: async () => ({ ok: false, error: 'folder_gone', missing: [3] }) }
  const tree = Drawer({ item: item({ folders: [] }), api, folders: FOLDERS, onDone: (r) => done.push(r.message) })
  await findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')[2].props.onChange({ target: { checked: true } })
  assert.match(done[0], /没记上/)
  assert.match(done[0], /已经不在了/)
})

test('收藏动作不发出去时不给"忙"的样子，防连点叠请求', () => {
  const tree = Drawer({ item: item({ folders: [] }), api: {}, folders: FOLDERS, collecting: true })
  const boxes = findAll(tree, 'bl-collect')[0].children.filter((n) => n.type === 'input')
  assert.equal(boxes.every((b) => b.props.disabled === true), true)
})

test('改名后的按钮仍然只写 tuning：提示文案里出现「这源多来点」且带 +0.1', () => {
  assert.match(feedbackHint('save'), /这源多来点/)
  assert.match(feedbackHint('save'), /\+0\.1/)
  assert.match(feedbackHint('save'), /不改你的主题词/)
  assert.doesNotMatch(feedbackHint('save'), /^收藏/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/views-drawer.test.js"`
Expected: FAIL — `collectSetOf` 不存在 / 断言文案不匹配

- [ ] **Step 3: 抽屉实现**

`src/client/views/drawer.js` 里改两处文案：

```js
export function feedbackHint(action) {
  return action === 'dismiss'
    ? '不感兴趣：只改来源权重（-0.1，累计限幅 ±0.5），不改你的主题词'
    : '这源多来点：只改来源权重（+0.1，累计限幅 ±0.5），不改你的主题词'
}
```

按钮那颗的 children 从 `['收藏']` 改成 `['这源多来点']`，`className` 保持 `bl-save`（它是样式钩子不是给人读的字；改名会牵动 CSS 与测试而没有收益）。

导出一个纯函数，集合的算法不许散在事件处理器里：

```js
/**
 * 勾上/取消某个夹之后该提交的集合。
 * 两个方向的规矩不同：加进来的按夹列表顺序排（面板两侧看着一致），
 * 但条目上已有的、夹列表里认不出的 id 一律原样留着——那多半是"这一秒刚被另一格删掉"，
 * 静默丢弃等于替用户做了他没做的决定。
 */
export function collectSetOf(item, folders, toggleId, on) {
  const cur = Array.isArray(item?.folders) ? item.folders.filter((x) => Number.isInteger(x)) : []
  const order = (folders ?? []).map((f) => f.id)
  const next = on ? [...new Set([...cur, toggleId])] : cur.filter((x) => x !== toggleId)
  return next.slice().sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b)
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a - b
  })
}
```

抽屉签名扩两个参数，并在正文区加一段：

```js
export function Drawer({ item, api = {}, onClose, onDone, note, folders = [], collecting = false }) {
  // …fire() 保持不变…

  async function toggleCollect(folderId, on) {
    return submit(collectSetOf(item, folders, folderId, on))
  }
  async function submit(folderIds, newFolder) {
    const res = await api.collect?.(item?.id, folderIds, newFolder)
    const message = res && res.ok
      ? `已放进：${namesOf(item, folders, res.data?.folder_ids ?? folderIds)}`
      : res && res.error === 'folder_gone'
        ? `没记上：有 ${res.missing?.length ?? 0} 个夹已经不在了，重新勾一次`
        : `没记上（${(res && res.error) || '宿主接口没应答'}）`
    onDone?.({ message, kind: 'collect' })
    return message
  }
```

区块本体（放在「能力边界」之后、「链接」之前，`bl-dmain` 里）：

```js
      Section({
        title: '收藏到…',
        children: [
          (folders ?? []).length ? null : vnode('p', { className: 'bl-missing' }, ['读不到夹（宿主接口没应答），这次没法收藏。']),
          (folders ?? []).length ? vnode('div', { className: 'bl-collect' }, folders.map((f) => vnode('label', { key: f.id }, [
            vnode('input', {
              type: 'checkbox',
              'aria-label': '放进：' + f.name,
              checked: (item.folders ?? []).includes(f.id),
              disabled: Boolean(collecting),
              onChange: (e) => toggleCollect(f.id, Boolean(e?.target?.checked))
            }),
            f.name + (f.is_default ? '（默认）' : '')
          ]))) : null,
          vnode('div', { className: 'bl-newfolder' }, [
            vnode('input', { type: 'text', 'aria-label': '新夹名', placeholder: '起个名，1-40 字', maxLength: 40, onChange: (e) => onNewFolderName?.(e?.target?.value ?? '') }),
            vnode('button', {
              type: 'button',
              disabled: Boolean(collecting),
              onClick: () => (newFolderName ?? '').trim()
                ? submit([...(item.folders ?? [])], (newFolderName || '').trim())
                : undefined
            }, ['新建夹并放入'])
          ])
        ]
      }),
```

`newFolderName` / `onNewFolderName` 是抽屉的两个新增入参（**装配层持有的瞬时输入**，不进 reducer，见 Task 8）：签名加上 `newFolderName = '', onNewFolderName = () => {}`。再加一个小 helper：

```js
const namesOf = (item, folders, ids) => (ids ?? []).map((id) =>
  (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`).join(' / ') || '（现在不在任何夹里）'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/views-drawer.test.js"`
Expected: PASS

- [ ] **Step 5: 扫文档（撞名的另一半）**

`docs/superpowers/specs/2026-10-23-baleen-design.md:233` 那句 `两个按钮的语义固定：…`——把 `收藏` 换成 `这源多来点`，并在同一行末尾加一句「（收藏一词在 M2.5 起专指本地收藏夹，见 `2026-10-24-baleen-collections-design.md` D13）」。第 351 行的 `收藏 / 不感兴趣 / 归档 / 跑一轮这些动作仍然不注册为工具` 改成 `收藏到夹 / 不感兴趣 / 这源多来点 / 归档 / 跑一轮这些动作仍然不注册为工具`——**留着原文会让人以为"收藏"这个词早已被工具面排除，而 M2.5 的 D17/D18 正是靠那个词落地的**。

- [ ] **Step 6: 提交**

```bash
git add src/client/views/drawer.js test/views-drawer.test.js docs/superpowers/specs/2026-10-23-baleen-design.md
git commit -m "feat: 抽屉按钮改名「这源多来点」，加「收藏到…」多选（点一下即生效）"
```

## Task 8: 收藏页、装配层接线与样式

**Files:**
- Create: `src/client/views/collections.js`
- Modify: `src/client/_footer.txt`（`VIEW_RENDER`、按视图取数、抽屉新入参、瞬时 state）
- Modify: `tools/build-client.mjs:23-24`（`PARTS` 加 `views/collections.js`）
- Modify: `src/client/css.js`（新类名）
- Test: `test/views-collections.test.js`（新建）、`test/client-boot.test.js`（追加）、`test/build.test.js`（无需改，守卫自动覆盖新文件）

**Interfaces:**
- Consumes: Task 6 的 `api.folders/collect/folderOp`、Task 7 的 `Drawer({folders, newFolderName, onNewFolderName})`
- Produces:
  - `CollectionsView({ state, items, folders, filters, pendingDelete, onPickFolder, onCreate, onRename, onAskDelete, onCancelDelete, onConfirmDelete, onOpen })`
  - `folderTabs(folders)` → 不改数据，只给顺序（默认夹永远第一）
  - `nameOf(folders, id)` → 夹名或 `#id（这个夹已经没了）`

- [ ] **Step 1: 写失败的测试**

新建 `test/views-collections.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { CollectionsView, folderTabs, nameOf } from '../src/client/views/collections.js'
import { text, findAll } from './helpers/tree.mjs'

const DAY = 86400000
const FOLDERS = [
  { id: 1, name: '默认', is_default: 1, count: 2 },
  { id: 2, name: '公共管理', is_default: 0, count: 1 },
  { id: 3, name: '空夹', is_default: 0, count: 0 }
]
const item = (over = {}) => ({
  id: 1, kind: 'article', source_id: 'demo', title: '一条收过的文章', author: '某作者',
  status: 'new', body_state: 'full', verdict_tier: null, match_json: '{}',
  url: 'https://example.invalid/x', folders: [1], folder_names: ['默认'], added_at: 5000, ...over
})

test('左列夹：默认夹排第一，条数写在名字后面，当前夹标 aria-current', () => {
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 2 } })
  const tabs = findAll(tree, 'bl-foldertab')
  assert.deepEqual(tabs.map((t) => t.props['data-folder']), [1, 2, 3])
  assert.deepEqual(tabs.map((t) => t.props['aria-current']), ['false', 'page', 'false'])
  assert.match(text(tabs[0]), /默认（默认）2/)
})

test('点夹名交出的是夹 id，不是名字', () => {
  const picked = []
  const tree = CollectionsView({ items: [], folders: FOLDERS, filters: {}, onPickFolder: (id) => picked.push(id) })
  findAll(tree, 'bl-foldertab')[2].props.onClick()
  assert.deepEqual(picked, [3])
})

test('一个夹都没读到时不画空标签栏，直接说读不到', () => {
  const t = text(CollectionsView({ items: [], folders: [], filters: {} }))
  assert.match(t, /读不到夹/)
  assert.equal(findAll(t === '' ? null : CollectionsView({ items: [], folders: [], filters: {} }), 'bl-foldertab').length, 0)
})

test('右区显示这个夹里的条目，并带上"还在哪些夹里"', () => {
  const tree = CollectionsView({
    items: [item({ id: 1, folders: [1, 2], folder_names: ['默认', '公共管理'] })],
    folders: FOLDERS, filters: { folder: 1 }
  })
  const card = findAll(tree, 'bl-card')[0]
  assert.match(text(card), /一条收过的文章/)
  assert.match(text(card), /还在：默认 / 公共管理/)
})

test('卡上的时间是收进来的时间，不是发布时间', () => {
  const tree = CollectionsView({
    items: [item({ added_at: Date.parse('2026-01-02T03:04:05Z'), published_at: Date.parse('2025-01-01T00:00:00Z') })],
    folders: FOLDERS, filters: { folder: 1 }
  })
  assert.match(text(tree), /2026/)
  assert.doesNotMatch(text(tree), /2025-01-01/)
})

test('已归档的条目照样列出，并写明"收藏不会让它重新出现在今天"', () => {
  const t = text(CollectionsView({
    items: [item({ status: 'archived', archived_reason: 'stale:20 天前' })], folders: FOLDERS, filters: { folder: 1 }
  }))
  assert.match(t, /已归档：stale:20 天前/)
  assert.match(t, /不会让它重新出现在今天/)
})

test('空夹与"没收到东西"两种空态说法不同', () => {
  const emptyFolder = text(CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 3 } }))
  assert.match(emptyFolder, /这个夹还是空的/)
  const nothingAtAll = text(CollectionsView({ items: [], folders: FOLDERS.map((f) => ({ ...f, count: 0 })), filters: {} }))
  assert.match(nothingAtAll, /一条都还没收过/)
  assert.doesNotMatch(nothingAtAll, /这个夹还是空的/)
})

test('工具条：新建夹输入框带 maxLength=40，改名走当前夹', () => {
  const created = []
  const renamed = []
  const tree = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 },
    onCreate: (n) => created.push(n), onRename: (id, n) => renamed.push([id, n]), newFolderName: '考研', currentName: '考研'
  })
  const inputs = findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'input')
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].props.maxLength, 40)
  assert.equal(inputs[1].props.value, '考研')
  inputs[1].props.onKeyDown({ key: 'Enter', target: { value: '新名' } })
  assert.deepEqual(renamed, [[2, '新名']])
  inputs[1].props.onKeyDown({ key: 'Tab', target: { value: '不该改' } })
  assert.equal(renamed.length, 1, '只有回车该提交改名，别的键在输入框里打字不该动库')
  findAll(tree, 'bl-toolbar')[0].children.filter((n) => n.type === 'button')[0].props.onClick()
  assert.deepEqual(created, ['考研'], '「建夹」按钮该把输入框里的名字交出去')
})

test('删默认夹的按钮根本不出现；删自建夹要先二次确认，确认前不许动手', () => {
  const asked = []
  const deleted = []
  const def = CollectionsView({ items: [], folders: FOLDERS, filters: { folder: 1 }, onAskDelete: (id) => asked.push(id) })
  assert.doesNotMatch(text(def), /删除这个夹/)
  const mine = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 },
    onAskDelete: (id) => asked.push(id), onDelete: () => { deleted.push(1) }
  })
  const btn = findAll(mine, 'bl-toolbar')[0].children.find((n) => n.type === 'button' && text(n).includes('删除这个夹'))
  btn.props.onClick()
  assert.deepEqual(asked, [2])
  assert.equal(deleted.length, 0, '第一次点就把夹删了，二次确认形同虚设')
})

test('二次确认的文案说清"只删关系不删条目"，取消能退回正常工具条', () => {
  const cancelled = []
  const tree = CollectionsView({
    items: [], folders: FOLDERS, filters: { folder: 2 }, pendingDelete: 2,
    onCancelDelete: () => cancelled.push('cancel'), onDelete: () => cancelled.push('delete')
  })
  const t = text(tree)
  assert.match(t, /只删收藏关系/)
  assert.match(t, /条目本身不动/)
  assert.match(t, /公共管理/)
  const btns = findAll(tree, 'bl-confirm')[0].children
  btns.find((b) => text(b).includes('取消')).props.onClick()
  btns.find((b) => text(b).includes('确认删除')).props.onClick()
  assert.deepEqual(cancelled, ['cancel', 'delete'])
})

test('collect/建夹的失败回显走同一行 note，不静默', () => {
  const t = text(CollectionsView({ items: [], folders: FOLDERS, filters: {}, note: '已经有这个夹了' }))
  assert.match(t, /已经有这个夹了/)
})

test('folderTabs 与 nameOf 两个纯函数', () => {
  assert.deepEqual(folderTabs([{ id: 5, is_default: 0 }, { id: 1, is_default: 1 }]).map((f) => f.id), [1, 5])
  assert.equal(nameOf(FOLDERS, 2), '公共管理')
  assert.match(nameOf(FOLDERS, 99), /99（这个夹已经没了）/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/views-collections.test.js"`
Expected: FAIL — 找不到 `../src/client/views/collections.js`

- [ ] **Step 3: 写收藏页**

新建 `src/client/views/collections.js`：

```js
/**
 * 「收藏」页：左列夹、右区这个夹里的条目。
 * 两条诚实规矩：
 *  1. 已归档的条目照样列出并标明原因——"我收过的东西不会凭空消失"（spec D15）；
 *  2. 夹上的数字与点进去的条数同源（都用 folder_items 的 COUNT，不筛状态）。
 */
import { vnode } from '../vnode.js'
import { fmtTime } from '../format.js'

export const folderTabs = (folders) => (folders ?? []).slice()
  .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id - b.id)

export const nameOf = (folders, id) =>
  (folders ?? []).find((f) => f.id === id)?.name ?? `#${id}（这个夹已经没了）`

function Row({ item, onOpen }) {
  return vnode('button', { type: 'button', className: 'bl-card', key: item.id, onClick: () => onOpen?.(item.id) }, [
    vnode('span', { className: 'bl-card-title' }, [item.title || '（无标题）']),
    vnode('span', { className: 'bl-card-meta' }, [
      item.source_id,
      item.kind === 'note' ? '图文笔记' : item.kind === 'video' ? '视频' : '文章',
      '收进来：' + fmtTime(item.added_at)
    ]),
    item.status === 'archived'
      ? vnode('span', { className: 'bl-missing' }, [
        `已归档：${item.archived_reason || '原因没记'}（收藏不会让它重新出现在今天）`
      ])
      : null,
    (item.folders ?? []).length
      ? vnode('span', { className: 'bl-in' }, ['还在：' + (item.folder_names ?? []).join(' / ')])
      : null
  ].filter(Boolean))
}

export function CollectionsView({
  items = [], folders = [], filters = {}, pendingDelete = null, note,
  newFolderName = '', currentName = '', onNewFolderNameChange = () => {},
  onPickFolder, onCreate, onRename, onAskDelete, onCancelDelete, onDelete, onOpen
}) {
  const cur = Number(filters.folder) || (folders[0] && folders[0].id) || null
  const curFolder = folders.find((f) => f.id === cur) ?? null
  const total = folders.reduce((n, f) => n + (Number(f.count) || 0), 0)
  const confirming = pendingDelete != null && pendingDelete === curFolder?.id

  return vnode('div', { className: 'bl-collections' }, [
    folders.length ? vnode('aside', { className: 'bl-folderlist', 'aria-label': '收藏夹' },
      folderTabs(folders).map((f) => vnode('button', {
        type: 'button', key: f.id, className: 'bl-foldertab', 'data-folder': f.id,
        'aria-current': f.id === cur ? 'page' : 'false',
        onClick: () => onPickFolder?.(f.id)
      }, [`${f.name}${f.is_default ? '（默认）' : ''} ${Number(f.count) || 0}`])))
      : null,
    vnode('div', { className: 'bl-collection-body' }, [
      confirming ? vnode('div', { className: 'bl-confirm', role: 'alertdialog', 'aria-label': '确认删除夹' }, [
        vnode('p', {}, [`确认删除「${curFolder.name}」？只删收藏关系，条目本身不动，里面 ${curFolder.count} 条还会在「库」里看得到。`]),
        vnode('button', { type: 'button', onClick: () => onCancelDelete?.() }, ['取消']),
        vnode('button', { type: 'button', className: 'bl-danger', onClick: () => onDelete?.(curFolder.id) }, ['确认删除'])
      ])
        : vnode('div', { className: 'bl-toolbar' }, [
          vnode('input', {
            type: 'text', 'aria-label': '新建夹名', placeholder: '新建收藏夹（1-40 字）', maxLength: 40,
            value: newFolderName,
            onChange: (e) => onNewFolderNameChange?.(e)
          }),
          vnode('button', { type: 'button', onClick: () => onCreate?.(newFolderName) }, ['建夹']),
          vnode('input', {
            type: 'text', 'aria-label': '当前夹名', value: currentName,
            onChange: (e) => e?.stopPropagation?.(),
            onKeyDown: (e) => { if (e?.key === 'Enter') onRename?.(cur, e?.target?.value ?? currentName) }
          }),
          vnode('button', { type: 'button', onClick: () => onRename?.(cur, currentName) }, ['改名']),
          curFolder && !curFolder.is_default
            ? vnode('button', { type: 'button', onClick: () => onAskDelete?.(cur) }, ['删除这个夹'])
            : null
        ].filter(Boolean)),
      note ? vnode('p', { className: 'bl-feedback', role: 'status' }, [note]) : null,
      items.length
        ? vnode('div', { className: 'bl-grid' }, items.map((i) => Row({ item: i, onOpen })))
        : vnode('p', { className: 'bl-empty' }, [
          !folders.length ? '读不到夹（宿主接口没应答）。这页列不出收藏关系，但库里收藏过的条目一条都没少。'
            : total === 0 ? '你一条都还没收过。在「今天」或「视频」里点开一条，抽屉下方有「收藏到…」。'
              : '这个夹还是空的。左边的数字是别的夹里的，点别的夹看看。'
        ])
    ])
  ])
}
```

`onNewFolderNameChange` 是装配层给的输入回调（Step 4 的 `setFolderDraft`），默认值 `() => {}` 让视图在没接线时也只是"打字没反应"，不会抛。

- [ ] **Step 4: 装配层接线**

`src/client/_footer.txt` 四处改动：

```js
    const VIEW_RENDER = {
      today: TodayView, video: VideoView, article: ArticleView,
      collections: CollectionsView, digest: DigestView, library: LibraryView
    }
```

`Panel` 里加三个瞬时 state（都是**装配层持有、不进 reducer**：刷新就没了的那些输入框与确认态）：

```js
      const [folders, setFolders] = React.useState([])
      const [pendingDelete, setPendingDelete] = React.useState(null)
      const [folderDraft, setFolderDraft] = React.useState({ newFolderName: '', currentName: '' })
      const [collectNote, setCollectNote] = React.useState('')
```

取数：收藏页与抽屉需要夹列表，所以 `view === 'collections'` 或抽屉打开时都拉一次，并按当前夹取条目。

```js
      function refresh(view = snap.view) {
        const f = snap.filters[view] || {}
        const q = view === 'library' ? { limit: 500 }
          : view === 'collections' ? { folder: Number(f.folder) || undefined, limit: 200 }
            : { status: LIVE_STATUS, limit: 200 }
        if (q.folder === undefined) delete q.folder
        return Promise.all([api.state(), api.items(q), api.folders()])
          .then(([s, it, fs]) => {
            setData({ state: s.data, items: (it.data && it.data.items) || [], stale: !s.ok })
            if (fs.ok) setFolders((fs.data && fs.data.folders) || [])
            if (view === 'collections') {
              const cur = (fs.data?.folders ?? []).find((x) => x.id === (Number(f.folder) || x.id)) ?? null
              setFolderDraft((d) => ({ ...d, currentName: d.currentName || cur?.name || '' }))
            }
          })
      }
```

`useEffect` 的依赖从 `[snap.view]` 扩成 `[snap.view, snap.filters.collections?.folder]`（对象可选链在本机 node 24 与打包 Electron 里都支持，仓库里已有同类写法则照旧）。

抽屉调用补上 Task 7 的入参：

```js
          ? toElement(Drawer({
            item: drawerItem, api, note: feedbackMsg, folders,
            newFolderName: folderDraft.newFolderName,
            onNewFolderName: (v) => setFolderDraft((d) => ({ ...d, newFolderName: v })),
            onClose: () => { setFeedbackMsg(''); dispatch({ type: 'close-drawer' }) },
            onDone: (r) => setFeedbackMsg(r.message)
          }))
```

收藏页调用补上处理器（`onFilter` 复用同一个 `dispatch`，选夹走标量 `filter`）：

```js
        collections: (props) => CollectionsView({
          ...props,
          folders,
          pendingDelete,
          note: collectNote,
          newFolderName: folderDraft.newFolderName,
          currentName: folderDraft.currentName,
          onNewFolderNameChange: (e) => setFolderDraft((d) => ({ ...d, newFolderName: e?.target?.value ?? '' })),
          onPickFolder: (id) => { setPendingDelete(null); dispatch({ type: 'filter', view: 'collections', key: 'folder', value: id }) },
          onCreate: (name) => runFolder('create', { name }, `建好了：${name}`),
          onRename: (id, name) => runFolder('rename', { id, name }, `已改名为「${name}」`),
          onAskDelete: (id) => setPendingDelete(id),
          onCancelDelete: () => setPendingDelete(null),
          onDelete: (id) => runFolder('delete', { id }, '夹删了，里面的条目一条都没动')
        })
```

`runFolder` 是装配层的一个小 helper（失败必须回显，不许 `catch {}`）：

```js
      function runFolder(action, args, okText) {
        api.folderOp(action, args).then((r) => {
          if (r.ok) {
            setCollectNote(okText)
            setFolders((r.data && r.data.folders) || folders)
            if (action === 'delete') setPendingDelete(null)
            refresh()
          } else {
            setCollectNote(r.error === 'name_taken' ? '已经有这个夹了'
              : r.error === 'name_too_long' ? '夹名最多 40 个字'
                : r.error === 'default_folder' ? '默认夹删不掉（它是随手一收的落点）'
                  : `没记上（${r.error || '未知原因'}）`)
          }
        })
      }
```

`VIEW_RENDER.collections` 现在直接是函数，而 `Panel` 里那行 `const render = VIEW_RENDER[view]` 会把 `collections` 当普通视图调用 —— **上面的 `collections: (props) => …` 是 `VIEW_RENDER` 的取值写法**：把整段 `(props) => CollectionsView({...})` 放进 `VIEW_RENDER`，而不是先放 `CollectionsView` 再在别处补丁。这样 `test/client-boot.test.js` 那条"六格三处同名 + 每个值都是函数"的守卫照样成立。

- [ ] **Step 5: 样式**

`src/client/css.js` 的 `CSS` 里追加（零颜色字面量，只用现有 token）：

```
.bl-collections{display:grid;grid-template-columns:150px minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.bl-folderlist{display:flex;flex-direction:column;gap:4px}
.bl-foldertab{appearance:none;font-family:inherit;text-align:left;font-size:12px;min-height:32px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bl-foldertab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bl-foldertab[aria-current="page"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}
.bl-collection-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.bl-in{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.bl-collect{display:flex;flex-direction:column;gap:2px}
.bl-collect label{display:flex;gap:6px;align-items:center;min-height:32px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.bl-newfolder{display:flex;gap:6px;align-items:center}
.bl-newfolder input{flex:1;min-width:110px;font-family:inherit;font-size:12px;padding:5px 8px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bl-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-primary)}
.bl-confirm button{appearance:none;font-family:inherit;font-size:12px;min-height:32px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.bl-confirm .bl-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
@media (max-width:820px){.bl-collections{grid-template-columns:minmax(0,1fr)}}
```

`test/css.test.js` 的类名双向扫描会自动把 `bl-in/bl-collect/bl-newfolder/bl-confirm/bl-danger/bl-foldertab/bl-folderlist/bl-collections/bl-collection-body` 拉进断言，不需要改测试。

- [ ] **Step 6: 跑全量、生成、提交**

```bash
node tools/build-client.mjs && node --check client.js
node --test "test/*.test.js"
```

Expected: 全绿 —— Task 6 Step 6 故意留下的那条守卫（六格三处同名）在这里转绿。

```bash
git add src/client/views/collections.js src/client/_footer.txt src/client/css.js tools/build-client.mjs client.js test/views-collections.test.js
git commit -m "feat: 收藏页（左列夹右区条目、删夹二次确认、归档条目照样列出）"
```

---

## Task 9: 预览门重出（六格 + 收藏页 + 抽屉多选）

**Files:**
- Modify: `test/fixtures/preview-data.js`（加 `previewFolders`、条目加 `folders/folder_names/added_at`）
- Modify: `tools/preview.mjs`（`pages` 加 `collections`，抽屉页传 `folders`）
- Test: `test/preview.test.js`（`NAMES` 与新增断言）

**Interfaces:**
- Consumes: Task 7/8 的 `Drawer({folders})`、`CollectionsView`
- Produces: `out/preview-collections.html`（连同原有七页，一共八页），每页仍是明暗两块

- [ ] **Step 1: 写失败的测试**

`test/preview.test.js` 顶部先补一行夹具 import（新测试要直接读它，而不是从渲染结果里反推）：

```js
import { previewItems, previewFolders } from '../test/fixtures/preview-data.js'
```

文件里两处改动 + 一段新增：

```js
const NAMES = ['preview-article.html', 'preview-collections.html', 'preview-digest.html', 'preview-drawer.html',
  'preview-library.html', 'preview-today.html', 'preview-trouble.html', 'preview-video.html']
```

```js
test('收藏页预览：左列夹带条数，右区带"还在哪些夹里"与一个归档条目', () => {
  const files = renderPreview({ outDir: tmp('collections') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-collections.html')), 'utf8')
  assert.match(html, /默认（默认）/)
  assert.match(html, /还在：/)
  assert.match(html, /不会让它重新出现在今天/)
  assert.match(html, /class="bl-foldertab"/)
  assert.match(html, /aria-current="page"/)
})

test('抽屉页里能看到「收藏到…」多选，且"这源多来点"已改名', () => {
  const files = renderPreview({ outDir: tmp('drawer2') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-drawer.html')), 'utf8')
  assert.match(html, /收藏到…/)
  assert.match(html, /放进：默认/)
  assert.match(html, /这源多来点/)
  assert.doesNotMatch(html, />收藏</, '旧名字的按钮还在预览里')
})

test('夹具自洽：每个夹的 count 必须等于实际挂着它的条数', () => {
  // 夹上的数字与点进去看到的条数不一致，收藏页就成了谎报覆盖面的那一格。
  // 这条测试不测渲染，测的是夹具自己别写错——写错夹具比写错视图更难查。
  for (const f of previewFolders) {
    const n = previewItems.filter((i) => (i.folders ?? []).includes(f.id)).length
    assert.equal(f.count, n, `${f.name} 的 count 是 ${f.count}，实际挂着 ${n} 条`)
  }
})

test('导航六格，收藏在文章之后汇报之前', () => {
  const files = renderPreview({ outDir: tmp('nav6') })
  const html = fs.readFileSync(files.find((f) => f.endsWith('preview-today.html')), 'utf8')
  const labels = [...html.matchAll(/<button class="bl-navitem"[^>]*>([^<]*)</g)].map((m) => m[1])
  assert.deepEqual([...new Set(labels)], ['今天', '视频', '文章', '收藏', '汇报', '库'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/preview.test.js"`
Expected: FAIL — `renderPreview` 的返回值里没有 `preview-collections.html`

- [ ] **Step 3: 夹具补夹**

`test/fixtures/preview-data.js` 顶部新增导出（夹的字段与 `listFolders` 的产出逐字一致）：

```js
export const previewFolders = [
  { id: 1, name: '默认', is_default: 1, count: 3 },
  { id: 2, name: '公共管理', is_default: 0, count: 2 },
  { id: 3, name: '要精读', is_default: 0, count: 0 }
]
```

`base()` 里补三个默认值，让每条都自带夹字段（`itemsWithFolders` 的产出也是这三个名字，预览用别名会在真机上空白）：

```js
const base = (over) => ({
  /* …现有字段不变… */
  folders: [], folder_names: [], added_at: T0, ...over
})
```

然后只给三条挂上夹——**默认夹的 `count: 3` 必须正好等于 `folders` 含 1 的条数**，夹上的数字与点进去看到的条数不一致是这页最容易犯的谎：

```js
  // id 1（B 站那条拆宿主半的）：进默认 + 公共管理
  folders: [1, 2], folder_names: ['默认', '公共管理'], added_at: T0 - 2 * DAY,
  // id 5（把决定权留给人的三种界面）：只进公共管理
  folders: [2], folder_names: ['公共管理'], added_at: T0 - DAY,
  // id 8（已归档那条旧文）：进默认——它就是"收了但今天看不见"的活样本
  folders: [1], folder_names: ['默认'], added_at: T0 - 3 * DAY,
```

- [ ] **Step 4: 预览器加一页并给抽屉传夹**

`tools/preview.mjs`：

```js
import { CollectionsView } from '../src/client/views/collections.js'
import { previewState, previewItems, previewFolders } from '../test/fixtures/preview-data.js'
```

`pages` 里加：

```js
    collections: both(shell({
      view: 'collections',
      state,
      body: CollectionsView({
        items: items.filter((i) => (i.folders ?? []).includes(1)),
        folders: previewFolders,
        filters: { folder: 1 },
        pendingDelete: null,
        note: '',
        newFolderName: '',
        currentName: '默认',
        onPickFolder: () => {}, onCreate: () => {}, onRename: () => {},
        onAskDelete: () => {}, onCancelDelete: () => {}, onDelete: () => {}, onOpen: () => {}
      })
    })),
```

`drawer` 那页给 `Drawer(...)` 加 `folders: previewFolders`；`empty` 模式下 `folders` 传 `[]`（于是收藏页走"读不到夹"那一支，抽屉走"没有夹列表"那一支——诚实的缺席也要演一遍）。

- [ ] **Step 5: 重新生成并核对**

```bash
node tools/preview.mjs
```

Expected: 打出八条路径，含 `out/preview-collections.html`。**这一版是交给人看的门**：明暗两块都要在浏览器里过一眼，确认六格导航、收藏页左右分栏不塌陷、归档条目那行红字在暗色下也读得清。

- [ ] **Step 6: 提交**

```bash
git add tools/preview.mjs test/fixtures/preview-data.js test/preview.test.js
git commit -m "feat: 预览门加收藏页与抽屉多选（六格导航，夹数字与条目同源）"
```

## Task 10: 文档扫尾与交付判据

**Files:**
- Modify: `AGENTS.md`（硬约束加一条）
- Modify: `README.md:7`（状态行）与 `README.md:13`（测试数）
- Modify: `docs/superpowers/plans/2026-10-24-baleen-m2-panel.md`（偏差记录加一条交叉引用）
- Test: 无新增测试文件；本任务只核对全绿与判据

**Interfaces:**
- Consumes: Task 1-9 的全部产出
- Produces: 无代码接口。交付判据一张 + 三份文档与代码一致。

- [ ] **Step 1: AGENTS.md 加一条硬约束**

`AGENTS.md` 的「硬约束」列表在第 10 条后追加第 11 条（照现有编号与写法，中文一行）：

```markdown
11. **收藏只写本机 sqlite**：`collect` / `folder` 三条路由只走面板 → 宿主，**绝不注册成 agent 工具**，也绝不碰平台的收藏/点赞接口（B 站恰好有个同名真动作）。默认夹可改名不可删（路由与 store 两层都拒）；夹名超长是**拒绝**而不是截断；已收藏的条目豁免 `runner.js` 的过期再归档，但移出后下一轮照旧清理。
```

- [ ] **Step 2: README 状态行**

`README.md:7` 的"当前状态"那句改成包含 M2.5：收藏页与抽屉多选已实现、预览八页、真机装载仍未做。`README.md:13` 的测试数从 `255` 改成本次 `node --test` 实际报出的数字（**不许写估的**，Step 4 跑完就有准数）。

- [ ] **Step 3: M2 计划里记一句"那版预览作废"**

在 `docs/superpowers/plans/2026-10-24-baleen-m2-panel.md` 的「实现偏差记录（M2）」末尾追加一条，说明 M2.5 会让本计划的交付判据 2（六份 HTML）变成八份、导航从五格变六格、抽屉那颗按钮改名，并把 `2026-10-24-baleen-collections-m25.md` 指过去。**别删 M2 那条判据**——它是当时那一里程碑的验收记录，改了就把"当初定了什么"抹平了。

- [ ] **Step 4: 全量回归**

```bash
node tools/build-client.mjs && node tools/build-client.mjs --check && node --check client.js
node --test "test/*.test.js"
node tools/preview.mjs
git status --short
```

Expected：`--check` 说"client.js 是最新的"；测试全绿；预览打出八条路径；`git status` 只剩 `out/`（被 gitignore）以外的空。**若 `--check` 报过期，说明有人手改了 `client.js`**——回到 `src/client/**` 改源头重新生成，不许把产物改动倒手抄回源文件。

- [ ] **Step 5: 交付判据逐条核对（写进提交信息或当场报告，不许整片打勾）**

1. `node --test "test/*.test.js"` 全绿；`test/css.test.js` 证明零硬编码颜色与 token 清单，`test/build.test.js` 证明 `client.js` 不是陈旧产物且 `views/collections.js` 已进 `PARTS`。
2. `test/runner.test.js` 的两条豁免测试都在（正反两面：收过的不动、没收的照旧动，移出后照旧动）。
3. `test/host-surface.test.js` 覆盖 `403 default_folder` / `409 name_taken` / `410 folder_gone` 三条，且日志测试证明夹名不进日志。
4. `test/client-boot.test.js` 的六格守卫绿；八页预览里明暗两块都能渲染，收藏页那页左列夹数字与右区条数一致。
5. 红线自查：`grep -rn "collect\|folder" index.js | grep -i tool` 无结果（没注册成工具）；代码里没有任何平台收藏接口路径。
6. **真机两项未做**（写清"没做"而不是"通过"）：面板装载与抽屉/收藏页实操验收；`docs/verification.md` 的 V4。

- [ ] **Step 6: 提交**

```bash
git add AGENTS.md README.md docs/superpowers/plans/2026-10-24-baleen-m2-panel.md
git commit -m "docs: 收藏的红线与状态（真机两项仍未做）"
```

---

## 本计划不做

- 批量收藏（库里勾选多条一次收进夹）—— spec §10 明确排除。
- 夹排序/拖拽、夹图标与配色、收藏夹导出、跨设备同步。
- 把 `collect` 或 `folder` 注册成 agent 工具（红线）。
- 让收藏影响预筛得分、`themes` 或 M3 的系统提示注入（D17）。
- 真机装载与 V4 实测（那是 M2 Task 11，要她先退出 DSH）。
- 任何 push / 发布 / 建仓动作。

## 已知取舍（执行时别当成 bug 去"修")

- **点一下勾就发一次请求**：`collect` 是全量替换，多选框每改一次提交一次。连点两下会发两次请求，但都是幂等的完整集合，服务端不存在"半途状态"。换来的是不需要草稿 state、不需要"保存"按钮、也不会出现"勾了忘提交"。
- **服务入口 `baleen.collect` 不代劳建夹**：`/collect` 路由内部先 `createFolder` 再 `setItemFolders`；别的插件若要用服务入口，自己先建夹。少一个参数就少一条"这个参数到底谁负责校验"的路径。
- **`items` 上不加任何收藏列**：`folders` / `folder_names` 是 `itemsWithFolders` 现算出来的视图字段，只出现在收藏页与抽屉的取数里。因此 `state()` 不带 `folder_count`，面板要数字就问 `/folders`。

---

## 自检（写完后端给自己看）

**1. Spec 覆盖** — 逐条对照：D13 改名 → Task 7（含主 spec 233/351 两行的扫尾）；D14 多对多 → Task 1/2；D15 豁免与不复活 → Task 3 + Task 8 的归档行文案与 `listItems` 不限状态；D16 第六格 → Task 6/8；D17 不影响推荐 → Task 10 判据 5 的红线自查（无代码改动，因为本来就不该有）；D18 两张表 → Task 1；§4 四条路由 → Task 4/5；§7 错误表七行 → Task 4 的九例 + Task 5 的 `folder_gone`/`no_item`/`bad_payload` + Task 6 的缺席回落；§9 八项测试 → Task 1-9 各自带。**无遗漏**。

**2. 占位符扫描** — 全文不许出现"执行时再补 / 类似 Task N / 加适当的错误处理"。发现两处并已改写：Task 8 的 `onNewFolderNameChange` 已补进签名，Task 9 的夹具字段改成实际代码行。

**3. 类型一致性** — `listFolders` 的产出 `{ id, name, is_default, count }` 在 Task 4 路由、Task 6 测试、Task 8 视图、Task 9 夹具四处同名同形；`setItemFolders(db, itemId, folderIds, now)` 的 `now` 参数在 Task 2 定义、Task 5 调用一致；`collect(itemId, folderIds, newFolder?)` 与 `POST /collect` 的 `item_id/folder_ids/new_folder` 逐字对齐；`Drawer` 的新入参 `folders/newFolderName/onNewFolderName` 在 Task 7 定义、Task 8 接线一致。

---

## 执行方式

计划落盘在 `docs/superpowers/plans/2026-10-24-baleen-collections-m25.md`。两种执行法：

1. **Subagent 驱动（推荐）** —— 每个任务派一个全新 subagent 实现，任务之间由我审一遍再放行。上下文隔离干净，适合这种任务边界很清楚的计划。
2. **本会话内顺序执行** —— 用 `superpowers:executing-plans`，在当前会话里按任务批量推进，每个任务结束设一次检查点。

