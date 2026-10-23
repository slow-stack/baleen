# Baleen M0+M1（验证 · 库 · RSS 摄取）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Baleen 装进 DSH 桌面版后，能按 `preference.yaml` 的时段窗定时抓取 RSS 源、规范化入库、两级去重、本地预筛，并且任何源失败时不推进它的游标——内容只会推迟，不会永久丢。

**Architecture:** 宿主半一个 cordis 服务 + 一个 SQLite 库。`adapters/` 只把外部世界翻译成 `RawItem`，判断与展示都不在这一层。本计划交付摄取侧闭环：scheduler 触发 → runner 编排 → 适配器抓取 → normalize/dedup/prefilter 入库。模型判断、面板、平台 MCP 通道留给后续计划。

**Tech Stack:** Node ESM（DSH 打包 runtime node 24.21.0；本机开发用独立 node）、`node:sqlite`（Task 0 实测后才敢依赖）、`node --test`（唯一测试框架）、`yaml`（唯一新增依赖，纯 JS、无 install 脚本）。

**Spec:** `docs/superpowers/specs/2026-10-23-baleen-design.md`（同仓库；执行时两份一起读，计划按它论证）

## Global Constraints

以下条目是每个任务的隐含要求，取值来自 spec 原文。

- 零新增 npm 依赖为首选；本计划唯一允许 `yaml`。要引入别的依赖必须先停下来问。
- 依赖版本写**精确号**，不带 `^`。本机 profile 的 pnpm 11 强制 24 小时 `minimumReleaseAge`，新发布版本会被拒；精确版本 + 已有 `minimumReleaseAgeExclude` 才可预期。
- **不做任何平台写操作**：不出现评论/私信/点赞/关注/发布的代码路径（spec §11 红线 1）。
- 库与凭据只落插件数据家目录 `~/.dsh/baleen/`（本机经 junction 实际在 D 盘），`.gitignore` 已挡住 `*.sqlite`。
- **失败不推进游标**：抓取失败的源，`sources.cursor` 保持原值（spec §6.1 核心不变量）。每个任务都要有断言覆盖这条。
- 网络/工具失败重试上限 **1 次**；超限即记 `failed` 并继续下一个源，禁止写临时脚本绕过（spec §11 红线 5）。
- 三档词固定 `值得看` / `可以看` / `不值当`，不许自创、不许写分数（spec §7）。本计划只建列、不填值。
- `body_state` 六值固定：`full` `summary_only` `subtitle` `transcribed` `missing` `burned_in`。`missing`（无语音）与 `burned_in`（硬字幕）是两种记录，不得合并（spec §4.1、§6.2）。
- 日志与诊断脱敏：不含用户名/真名、不含带个人目录的绝对路径、不含 token/cookie（spec §11 红线 7）。测试断言里也用占位路径。
- DSH 客户端 `ctx` 是 Proxy：未写进 `package.json` 的 `dsh.client.inject` 的服务，`ctx.get()` 与属性访问都会抛。本计划不含客户端；Task 10 宿主接线只用 `webServer`。
- 侧栏 `sidebar.panellist` 注册的 `id` 必须与 `main` 面板 key 完全同名（本计划不注册，写进 `AGENTS.md` 给后续计划遵守）。
- 主题只消费 `--dsw-alias-*` token，明暗双主题是验收项（本计划无 UI，写进 `AGENTS.md`）。
- 提交信息用中文，前缀 `feat:` / `test:` / `docs:` / `chore:`；每个任务一次提交。
- 仓库是 CRLF 工作副本：写多行锚点的脚本时用 `\r?\n` 匹配，别假设只有 LF。
- 生成含 Windows 绝对路径的文件时，用脚本拼接写入并读回验证（本机已证实编辑工具会静默删掉路径串）。
- 测试一律 `node --test`，单文件用 `node --test test/x.test.js`，全量用 `npm test`（脚本是 `node --test "test/*.test.js"`）。**Windows 下 `node --test test/` 会把目录当模块解析而 `Cannot find module`**，别用那个形式。禁止引入 jest/vitest。

## 文件结构（本计划将建立的边界）

```
package.json                 插件清单：dsh.bundle.patch、精确版本依赖、node --test
index.js                     宿主半入口：apply(ctx, config)，装配服务/路由/定时器
cordis.patch.yml             bundle patch（insert id=baleen name=dsh-baleen）
lib/paths.js                 家目录解析与创建（唯一知道"数据存哪儿"的文件）
lib/store.js                 node:sqlite 打开、迁移、全部读写语句
lib/sql/items.sql            三表 DDL（items / runs / digests）+ sources 与 meta 表
lib/preference.js            读 preference.yaml、校验、内置默认、tuning 读写
lib/feed.js                  RSS2 / Atom 文本 → 结构（纯函数，不碰网络）
lib/url.js                   URL 规范化（去跟踪参数），供两级去重使用
lib/adapters/index.js        适配器注册表：按 source.type 取实现
lib/adapters/rss.js          RawItem 生产者：抓取 + 解析 + 错误分类
lib/normalize.js             RawItem + source → Item（kind / body_state / match）
lib/dedup.js                 两级去重查询（唯一键 + 14 天内同 URL 或同标题同作者）
lib/prefilter.js             本地规则闸门，返回 pass 或原因（不调模型）
lib/jobs.js                  从 preference + sources 生成 fetch job（含游标）
lib/pool.js                  并发上限 4 + 单 job 超时 20s + 重试 1 次
lib/runner.js                runOnce：编排 8 步里的 1–5，写 runs 状态机
lib/scheduler.js             时段窗判断、单实例锁、手动触发入口
test/*.test.js               与 lib 一一对应的单测
test/fixtures/*.xml          RSS / Atom / 脏数据样本（真结构，假内容）
test/helpers/fake-adapter.js 契约测试用的假适配器
selfcheck.mjs                V1/V2 实测脚本（本计划 Task 0）
AGENTS.md                    项目约定：上面的 Global Constraints 的可读版本
```

一个文件一个责任；`feed.js` / `normalize.js` / `dedup.js` / `prefilter.js` 是纯函数或纯查询，任何输入不产生副作用，因此可打表测。`runner.js` 是唯一会改 `items.status` 和 `runs` 的地方；`scheduler.js` 只决定"什么时候放一个 run 进队列"，不认识平台也不写库。

---

## Task 0: 实测 V1 与 V2（决定两个退路，不写产品代码）

**Files:**
- Create: `selfcheck.mjs`
- Create: `docs/verification.md`
- Modify: 无

**Interfaces:**
- Consumes: 无
- Produces: `docs/verification.md` 里的 V1/V2 结论；后续任务据此选 `store.js` 的实现（sqlite 或 JSONL 退路）

- [ ] **Step 1: 确认本机独立 node 的版本，并找到 DSH 打包的 node**

Run（Git Bash）:
```bash
node --version
ls -la "/d/Program Files/DeepSeek Harness/resources/runtime/"
find "/d/Program Files/DeepSeek Harness/resources/runtime" -maxdepth 4 -type f -iname "node*" 2>/dev/null | head
```
Expected: 打出本机 node 版本；runtime 目录下**可能存在没有 `.exe` 后缀的 node 文件**。若找不到可执行体，记为"打包 node 无法直接调用"，用本机 node 作代理并在文档里写明差异。

- [ ] **Step 2: 写 `selfcheck.mjs`（探测 `node:sqlite` 建表插查）**

```js
// selfcheck.mjs —— V1：node:sqlite 能否建表、插入、查询、处理中文
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
const ins = db.prepare('INSERT INTO t (name) VALUES (?)')
ins.run('值得看')
ins.run('标题党「十款工具」')
const rows = db.prepare('SELECT id, name FROM t ORDER BY id').all()
const ok = rows.length === 2 && rows[0].name === '值得看' && rows[1].name.includes('十款工具')
process.stdout.write(`node:sqlite ${ok ? 'OK' : 'FAIL'} ${JSON.stringify(rows)}\n`)
process.exitCode = ok ? 0 : 1
```

- [ ] **Step 3: 分别用本机 node 和（若可用）打包 node 跑它**

Run:
```bash
node selfcheck.mjs
```
Expected: `node:sqlite OK [...]`，退出码 0。失败则启用退路（Step 5）。

- [ ] **Step 4: 探测 headless 会话能不能被拉起来（V2）**

Run:
```bash
DSH="/d/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
ls -la "$DSH"
"$DSH" --help 2>&1 | head -40
ls -la /d/DSH/.dsh/profiles/ 2>/dev/null
```
Expected: 打出 dsh CLI 的用法（记录 `--profile` 接受哪些值、是否能非交互执行一句话）。**只探测，不真跑抓取**；真正的"起一轮"验收放在 M3。任何需要联网调模型的动作，先问用户再执行。

- [ ] **Step 5: 把结论写进 `docs/verification.md`（含失败时的退路是否启用）**

模板（每一行的值都由前面步骤的真实输出填，一行都不许空着）:
```markdown
# 实测记录

## V1 node:sqlite
- 本机 node 版本：← Step 1 `node --version` 的原样输出
- 打包 node 可调用：是 / 否 ← Step 1 的 `find` 结果；为"否"时写清找到的最接近路径（脱敏后）
- 建表插查：OK / FAIL ← Step 3 的 stdout
- 结论：store 用 sqlite / 退 JSONL + 内存索引 ← 与上一行一致，不允许两边矛盾

## V2 headless 会话
- dsh CLI 路径与是否存在 ← Step 4 的 `ls`
- `--profile` 可选值 ← Step 4 的 `--help` 原文摘录（只摘相关行）
- 能否非交互执行：能 / 不能 / 未测 ← 未测必须写"为什么没测到"
- 结论：判断轮走自动 / 只手动触发
```

- [ ] **Step 6: 提交**

```bash
git add selfcheck.mjs docs/verification.md
git commit -m "chore: 实测 node:sqlite 可用性与 dsh headless 入口"
```

---

## Task 1: 项目骨架、家目录与三表迁移

**Files:**
- Create: `package.json`
- Create: `lib/paths.js`
- Create: `lib/sql/items.sql`
- Create: `lib/store.js`
- Create: `test/store.test.js`
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: Task 0 的 V1 结论
- Produces:
  - `openStore(): { db, close() }` — `db` 是 `DatabaseSync`
  - `migrate(db): void`（幂等，可重复调用）
  - `setMeta(db, key, value)` / `getMeta(db, key)`（游标与默认值都存这里）
  - `homeDir(): string`、`ensureHome(): string`

- [ ] **Step 0: 先落 `package.json` 与 `AGENTS.md`**（Step 7/9 的内容**必须提前**：测试文件用的是 ESM，没有 `type: module` 时 `node --test` 直接报 `Cannot use import statement outside a module`。实测本机 `node --test test/` 也会因把目录当模块解析而失败，所以测试脚本写成 `node --test "test/*.test.js"`。）

- [ ] **Step 1: 写失败的测试 `test/store.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, migrate, setMeta, getMeta } from '../lib/store.js'

test('migrate 建出四张表且可重复执行', () => {
  const { db } = openStore(':memory:')
  migrate(db); migrate(db)
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)
  for (const t of ['items', 'runs', 'digests', 'sources', 'meta']) {
    assert.ok(names.includes(t), `缺表 ${t}`)
  }
  db.close()
})

test('items 的 (source_id, external_id) 唯一', () => {
  const { db } = openStore(':memory:')
  const sql = `INSERT INTO items (source_id, external_id, kind, title, url, body_state, status, fetched_at)
               VALUES ('s1','e1','article','t','u','full','new',1)`
  db.prepare(sql).run()
  assert.throws(() => db.prepare(sql).run(), /UNIQUE/)
  db.close()
})

test('meta 读写', () => {
  const { db } = openStore(':memory:')
  assert.equal(getMeta(db, 'nope'), null)
  setMeta(db, 'cursor:s1', '2026-10-23T00:00:00.000Z')
  assert.equal(getMeta(db, 'cursor:s1'), '2026-10-23T00:00:00.000Z')
  setMeta(db, 'cursor:s1', '2026-10-24T00:00:00.000Z')
  assert.equal(getMeta(db, 'cursor:s1'), '2026-10-24T00:00:00.000Z')
  db.close()
})

test('body_state 与 tier 的取值约束由应用层保证，DDL 只挡住 NOT NULL', () => {
  const { db } = openStore(':memory:')
  assert.throws(() => db.prepare(
    "INSERT INTO items (source_id, external_id, kind, title, url, status, fetched_at) VALUES ('a','b','video','t','u','new',1)"
  ).run(), /NOT NULL/)
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../lib/store.js'`

- [ ] **Step 3: 写 `lib/paths.js`**

```js
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const DIR_NAME = 'baleen'

export function homeDir() {
  const override = process.env.BALEEN_HOME
  if (override && override.trim()) return override.trim()
  const explicit = process.env.DSH_HOME
  const root = explicit && explicit.trim() ? explicit.trim() : path.join(os.homedir(), '.dsh')
  return path.join(root, DIR_NAME)
}

export function ensureHome() {
  const dir = homeDir()
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  return dir
}

export function dbFile() {
  return path.join(ensureHome(), 'baleen.sqlite')
}
```

- [ ] **Step 4: 写 `lib/sql/items.sql`**

```sql
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  author_id TEXT,
  published_at INTEGER,
  time_estimated INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  thumb TEXT,
  duration_sec INTEGER,
  stats_json TEXT,
  tags_json TEXT,
  locale TEXT,
  body_text TEXT,
  body_state TEXT NOT NULL,
  match_json TEXT,
  verdict_tier TEXT,
  verdict_why TEXT,
  verdict_run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  archived_reason TEXT,
  feedback TEXT,
  seen_at INTEGER,
  prefilter_score REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_key ON items (source_id, external_id);
CREATE INDEX IF NOT EXISTS ix_items_status ON items (status, published_at);
CREATE INDEX IF NOT EXISTS ix_items_url ON items (url);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  url TEXT,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_min INTEGER NOT NULL DEFAULT 720,
  weight REAL NOT NULL DEFAULT 1.0,
  cursor TEXT,
  last_error_class TEXT,
  last_error TEXT,
  last_ok_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  per_source_json TEXT,
  candidates INTEGER NOT NULL DEFAULT 0,
  judged INTEGER NOT NULL DEFAULT 0,
  model_run_id TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  markdown_path TEXT,
  headline TEXT,
  stats_json TEXT,
  theme_json TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 5: 写 `lib/store.js`**

```js
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbFile } from './paths.js'

const DDL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', 'items.sql'),
  'utf8'
)

export function openStore(file) {
  const target = file ?? dbFile()
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true })
  const db = new DatabaseSync(target)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  return { db, file: target, close: () => db.close() }
}

export function migrate(db) {
  db.exec(DDL)
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/store.test.js`
Expected: PASS 4 tests

- [ ] **Step 7: 写 `package.json`**

```json
{
  "name": "dsh-baleen",
  "version": "0.1.0",
  "description": "信息源聚合 DSH 插件：定时摄取入库（RSS 为主、平台 MCP 为辅），本地预筛 + 三档判断 + 每轮增量汇报。彻底不做平台互动。",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "scripts": { "test": "node --test \"test/*.test.js\"" },
  "dependencies": { "yaml": "2.8.2" },
  "engines": { "node": ">=22.13.0" },
  "files": ["index.js", "lib/", "cordis.patch.yml", "AGENTS.md", "README.md"],
  "keywords": ["dsh", "dsh-plugin", "rss", "aggregation", "bilibili", "xiaohongshu"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/slow-stack/dsh-baleen.git" }
}
```

注意：`yaml` 是**精确版本**。执行到这里先跑 `node -e "import('yaml').then(m=>console.log(m.parse('a: 1')))"` 验证依赖可用；装不上时不许换别的解析库，停下来报告。

- [ ] **Step 8: 写 `cordis.patch.yml`**

```yaml
# dsh-baleen 自带挂载声明。name 用裸包名（可发布形态）；
# 本机热挂载调试会被改写成 file:///<绝对路径>?v=N —— 那个形态不要提交。
- insert:
    - id: baleen
      name: dsh-baleen
      config:
        enabled: true
```

- [ ] **Step 9: 写 `AGENTS.md`（把 Global Constraints 落成人读版本，并记下三个未验证点）**

必须包含的条目（原文照抄本计划 Global Constraints 的每一条），外加：

```markdown
## 本仓库的坑（执行前读）
- 工作副本是 CRLF，多行锚点脚本要 `\r?\n`。
- 编辑工具可能静默删掉内容里的 Windows 绝对路径：写含路径的文件后用脚本生成并读回验证。
- `git checkout -- <file>` 会连未提交改动一起回退；自证前先 `cp` 备份。
- 客户端 inject 缺失会炸启动：任何 `ctx.xxx` 都要先出现在 package.json 的 dsh.client.inject 里，并且属性读取也要包 try。
- 侧栏 `sidebar.panellist` 的 id 必须与 `main` 面板 key 同名。
- 本计划尚未注册任何客户端；M2 的面板计划会加 `dsh.client`。
```

- [ ] **Step 10: 全量测试 + 提交**

Run: `node --test "test/*.test.js"`
Expected: PASS

```bash
git add package.json cordis.patch.yml AGENTS.md lib/ test/
git commit -m "feat: 插件骨架与条目库三表迁移"
```

---

## Task 2: 偏好文件读取、校验与 tuning 语义

**Files:**
- Create: `lib/preference.js`
- Test: `test/preference.test.js`

**Interfaces:**
- Consumes: `lib/paths.js::homeDir()`（Task 1）
- Produces:
  - `loadPreference(dir?) → { pref, errors, source }`，`source` 为 `'file' | 'defaults'`
  - `validate(obj) → string[]`（每条形如 `sources[0].url: rss 源必须有 url`）
  - `bumpTuning(pref, sourceId, delta) → pref`（只改 `tuning.source_delta`，限幅 ±0.5）
  - `ensurePreferenceFile(dir?) → path`（缺文件时写出默认模板）
  - `PREF` 对象形状即 spec §5

- [ ] **Step 1: 写失败的测试 `test/preference.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPreference, validate, bumpTuning, ensurePreferenceFile } from '../lib/preference.js'

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-pref-'))
  return d
}

test('文件缺失时用内置默认并标明来源', () => {
  const { pref, errors, source } = loadPreference(tmp())
  assert.equal(source, 'defaults')
  assert.deepEqual(errors, [])
  assert.equal(pref.schedule.max_per_run, 25)
})

test('合法文件被采纳，非法时报出字段路径且不返回半成品', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'preference.yaml'), [
    'version: 1',
    'themes:',
    '  - group: AI',
    '    any: [MCP, 智能体]',
    '    never: [盘点合集]',
    '    weight: 1.0',
    'sources:',
    '  - id: blog-a',
    '    type: rss',
    '    url: https://example.com/feed',
    '    interval_min: 720',
    '    weight: 0.8',
    'schedule:',
    '  windows: ["07:00-09:00"]',
    '  max_per_run: 10',
    '  max_per_day: 40',
    ''
  ].join('\n'))
  const good = loadPreference(d)
  assert.equal(good.source, 'file')
  assert.deepEqual(good.errors, [])
  assert.equal(good.pref.sources[0].id, 'blog-a')

  fs.writeFileSync(path.join(d, 'preference.yaml'), 'schedule:\n  windows: ["7am-9am"]\n')
  const bad = loadPreference(d)
  assert.equal(bad.source, 'defaults')
  assert.ok(bad.errors.some(e => e.startsWith('schedule.windows[0]')), bad.errors.join('|'))
})

test('源 id 重复与 rss 缺 url 都被拒', () => {
  const errs = validate({
    version: 1,
    sources: [
      { id: 'a', type: 'rss', url: 'https://x/f' },
      { id: 'a', type: 'rss', url: 'https://y/f' },
      { id: 'b', type: 'rss' }
    ]
  })
  assert.ok(errs.some(e => /重复/.test(e)), errs.join('|'))
  assert.ok(errs.some(e => e.startsWith('sources[2].url')), errs.join('|'))
})

test('两个按钮只写 tuning，themes 一个字节都不动', () => {
  const base = { themes: [{ group: 'AI', any: ['MCP'], weight: 1.0 }], tuning: { source_delta: {} } }
  const after = bumpTuning(base, 'blog-a', -0.1)
  assert.deepEqual(after.themes, base.themes)
  assert.equal(after.tuning.source_delta['blog-a'], -0.1)
  let p = after
  for (let i = 0; i < 20; i++) p = bumpTuning(p, 'blog-a', -0.1)
  assert.equal(p.tuning.source_delta['blog-a'], -0.5)
})

test('ensurePreferenceFile 幂等，不覆盖已存在的文件', () => {
  const d = tmp()
  const p1 = ensurePreferenceFile(d)
  fs.writeFileSync(p1, 'version: 1\nthemes: []\n')
  const p2 = ensurePreferenceFile(d)
  assert.equal(p1, p2)
  assert.match(fs.readFileSync(p2, 'utf8'), /themes: \[\]/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/preference.test.js`
Expected: FAIL — `Cannot find module '../lib/preference.js'`

- [ ] **Step 3: 写 `lib/preference.js`**

```js
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { homeDir } from './paths.js'

const FILE = 'preference.yaml'
const CLAMP = 0.5
const KNOWN_TYPES = ['rss']          // bili / xhs / yt 由后续计划登记进来

export const DEFAULTS = {
  version: 1,
  themes: [],
  follow: {},
  sources: [],
  schedule: { windows: ['07:00-09:00', '12:30-13:30'], off_peak_only: true, max_per_run: 25, max_per_day: 60 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  tuning: { source_delta: {} },
  redlines: ['广告代理', '引流私聊', '付费课程推销'],
  charter: ''
}

export function prefFile(dir = homeDir()) { return path.join(dir, FILE) }

export function ensurePreferenceFile(dir = homeDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, YAML.stringify(DEFAULTS) + '# 改这里：themes / follow / sources 是你的，tuning 只由面板两个按钮写。\n', 'utf8')
  }
  return target
}

export function loadPreference(dir = homeDir()) {
  const target = prefFile(dir)
  if (!fs.existsSync(target)) {
    return { pref: structuredClone(DEFAULTS), errors: [], source: 'defaults', missing: true }
  }
  let parsed
  try {
    parsed = YAML.parse(fs.readFileSync(target, 'utf8'))
  } catch (e) {
    return { pref: structuredClone(DEFAULTS), errors: [`preference.yaml 解析失败: ${e.message}`], source: 'defaults' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { pref: structuredClone(DEFAULTS), errors: ['preference.yaml 不是对象'], source: 'defaults' }
  }
  const errors = validate(parsed)
  if (errors.length) {
    return { pref: structuredClone(DEFAULTS), errors, source: 'defaults' }
  }
  const pref = mergeDefaults(DEFAULTS, parsed)
  return { pref, errors: [], source: 'file' }
}

export function validate(obj) {
  const errs = []
  const isArr = v => Array.isArray(v)
  if (obj.version !== undefined && typeof obj.version !== 'number') errs.push('version: 必须是数字')
  if (obj.themes !== undefined) {
    if (!isArr(obj.themes)) errs.push('themes: 必须是数组')
    else obj.themes.forEach((t, i) => {
      if (!t || typeof t.group !== 'string' || !t.group.trim()) errs.push(`themes[${i}].group: 必填字符串`)
      for (const k of ['must', 'any', 'never']) {
        if (t?.[k] !== undefined && (!isArr(t[k]) || t[k].some(s => typeof s !== 'string'))) errs.push(`themes[${i}].${k}: 必须是字符串数组`)
      }
      if (t?.weight !== undefined && !(Number.isFinite(t.weight) && t.weight >= 0 && t.weight <= 2)) errs.push(`themes[${i}].weight: 0–2`)
    })
  }
  const seen = new Set()
  if (obj.sources !== undefined) {
    if (!isArr(obj.sources)) errs.push('sources: 必须是数组')
    else obj.sources.forEach((s, i) => {
      if (!s || typeof s.id !== 'string' || !s.id.trim()) { errs.push(`sources[${i}].id: 必填字符串`); return }
      if (seen.has(s.id)) errs.push(`sources[${i}].id: 与前面的源重复 "${s.id}"`)
      seen.add(s.id)
      if (!KNOWN_TYPES.includes(s.type)) errs.push(`sources[${i}].type: 只支持 ${KNOWN_TYPES.join('/')}`)
      if (s.type === 'rss' && (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url))) errs.push(`sources[${i}].url: rss 源必须是 http(s) URL`)
      if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errs.push(`sources[${i}].enabled: 必须是布尔`)
      if (s.interval_min !== undefined && !(Number.isInteger(s.interval_min) && s.interval_min >= 15)) errs.push(`sources[${i}].interval_min: ≥15 的整数`)
      if (s.weight !== undefined && !(Number.isFinite(s.weight) && s.weight >= 0 && s.weight <= 2)) errs.push(`sources[${i}].weight: 0–2`)
    })
  }
  if (obj.schedule?.windows !== undefined) {
    if (!isArr(obj.schedule.windows)) errs.push('schedule.windows: 必须是数组')
    else obj.schedule.windows.forEach((w, i) => {
      if (typeof w !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(w)) {
        errs.push(`schedule.windows[${i}]: 要写成 "07:00-09:00"`)
      }
    })
  }
  for (const k of ['max_per_run', 'max_per_day']) {
    const v = obj.schedule?.[k]
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) errs.push(`schedule.${k}: 正整数`)
  }
  for (const k of ['max_age_days', 'min_duration_sec']) {
    const v = obj.limits?.[k]
    if (v !== undefined && !(Number.isInteger(v) && v >= 0)) errs.push(`limits.${k}: 非负整数`)
  }
  if (obj.limits?.skip_kinds !== undefined && !isArr(obj.limits.skip_kinds)) errs.push('limits.skip_kinds: 必须是数组')
  if (obj.redlines !== undefined && !isArr(obj.redlines)) errs.push('redlines: 必须是数组')
  if (obj.tuning?.source_delta !== undefined) {
    const sd = obj.tuning.source_delta
    if (!sd || typeof sd !== 'object' || Array.isArray(sd)) errs.push('tuning.source_delta: 必须是映射')
    else for (const [k, v] of Object.entries(sd)) {
      if (!Number.isFinite(v) || Math.abs(v) > CLAMP) errs.push(`tuning.source_delta.${k}: 限幅 ±${CLAMP}`)
    }
  }
  if (obj.charter !== undefined && typeof obj.charter !== 'string') errs.push('charter: 必须是字符串')
  return errs
}

export function bumpTuning(pref, sourceId, delta) {
  const next = structuredClone(pref)
  next.tuning = next.tuning || { source_delta: {} }
  next.tuning.source_delta = next.tuning.source_delta || {}
  const cur = next.tuning.source_delta[sourceId] ?? 0
  next.tuning.source_delta[sourceId] = Math.max(-CLAMP, Math.min(CLAMP, Math.round((cur + delta) * 100) / 100))
  return next
}

function mergeDefaults(base, over) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDefaults(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/preference.test.js`
Expected: PASS 5 tests

- [ ] **Step 5: 提交**

```bash
git add lib/preference.js test/preference.test.js package.json
git commit -m "feat: 偏好文件读取、校验与只写 tuning 的粗调"
```

---

## Task 3: feed 文本解析（RSS2 + Atom，脏数据容错）

**Files:**
- Create: `lib/feed.js`
- Create: `test/fixtures/substack.xml`
- Create: `test/fixtures/atom.xml`
- Test: `test/feed.test.js`

**Interfaces:**
- Consumes: 无（纯文本入，结构出）
- Produces:
  - `parseFeed(xmlText) → { feed_title, format: 'rss'|'atom'|'unknown', items: FeedEntry[] }`
  - `FeedEntry = { external_id, url, title, author, published_at, body_html, summary_html, thumb, duration_sec, tags }`
  - `stripTags(html) → string`、`decode(text) → string`（Task 5 的 normalize 会复用）
  - 约定：解析不出条目的输入返回 `items: []` 而不是抛异常；字段缺失一律 `null`。

- [ ] **Step 1: 写 fixture `test/fixtures/substack.xml`**（真结构、假内容）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Naval Notes</title>
  <link>https://example.substack.com</link>
  <item>
    <title><![CDATA[为什么 RSS 还活着：12 个新闻站的取样]]></title>
    <description>我们测了 12 个站点，其中 9 个提供完整正文。</description>
    <content:encoded><![CDATA[<p>全文首段：我们测了 12 个站点。</p><p>第二段有数字：9/12。</p>]]></content:encoded>
    <link>https://example.substack.com/p/rss-2026?utm_source=twitter&amp;utm_campaign=x</link>
    <guid isPermaLink="false">rss-33771</guid>
    <dc:creator><![CDATA[A. Lefèvre]]></dc:creator>
    <pubDate>Wed, 21 Oct 2026 06:00:00 GMT</pubDate>
    <category>工具</category><category>资讯</category>
  </item>
  <item>
    <title>只有摘要的一则</title>
    <description>摘要而已。</description>
    <link>https://example.substack.com/p/summary-only</link>
    <pubDate>not-a-date</pubDate>
  </item>
</channel>
</rss>
```

- [ ] **Step 2: 写 fixture `test/fixtures/atom.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Frame Work</title>
  <link rel="alternate" href="https://blog.example.org"/>
  <entry>
    <id>tag:blog.example.org,2026:/p/118</id>
    <link rel="alternate" href="https://blog.example.org/p/118"/>
    <title>硬字幕视频的 OCR 兜底：值不值得做</title>
    <updated>2026-10-22T01:15:00Z</updated>
    <author><name>桉</name></author>
    <media:thumbnail url="https://blog.example.org/i/118.jpg"/>
    <content type="html">&lt;p&gt;burned&amp;#95;in 要单独一档。&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:blog.example.org,2026:/p/119</id>
    <link href="https://blog.example.org/p/119"/>
    <title>&lt;震惊&gt; &amp;amp; 转义测试</title>
    <summary>只有 summary</summary>
  </entry>
</feed>
```

- [ ] **Step 3: 写失败的测试 `test/feed.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFeed, stripTags, decode } from '../lib/feed.js'

const fx = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f), 'utf8')

test('RSS2：CDATA 标题、全文与摘要分开拿到、guid 作 id', () => {
  const { format, feed_title, items } = parseFeed(fx('substack.xml'))
  assert.equal(format, 'rss')
  assert.equal(feed_title, 'Naval Notes')
  assert.equal(items.length, 2)
  const a = items[0]
  assert.equal(a.title, '为什么 RSS 还活着：12 个新闻站的取样')
  assert.equal(a.external_id, 'rss-33771')
  assert.equal(a.author, 'A. Lefèvre')
  assert.ok(a.body_html.includes('第二段有数字'))
  assert.ok(a.summary_html.includes('9 个提供完整正文'))
  assert.equal(a.duration_sec, null)
  assert.deepEqual(a.tags, ['工具', '资讯'])
  assert.equal(typeof a.published_at, 'number')
})

test('RSS2：坏日期不炸，字段落 null 并标记可估算', () => {
  const { items } = parseFeed(fx('substack.xml'))
  const b = items[1]
  assert.equal(b.published_at, null)
  assert.equal(b.body_html, null)
  assert.equal(b.external_id, 'https://example.substack.com/p/summary-only')  // 无 guid 时退到 link
})

test('Atom：link rel=alternate、嵌套 author、media 缩略图、HTML 实体正文', () => {
  const { format, items } = parseFeed(fx('atom.xml'))
  assert.equal(format, 'atom')
  assert.equal(items[0].url, 'https://blog.example.org/p/118')
  assert.equal(items[0].thumb, 'https://blog.example.org/i/118.jpg')
  assert.equal(items[0].author, '桉')
  assert.ok(stripTags(items[0].body_html).includes('burned_in'))
  assert.equal(items[1].title, '<震惊> & 转义测试')
  assert.equal(items[1].body_html, null)
  assert.equal(items[1].summary_html, '只有 summary')
})

test('跟踪参数与时长：utm 清掉、"18:22" 与 "1:02:03" 与纯秒数都换算', () => {
  const xml = `<rss><channel><title>t</title>
    <item><title>x</title><link>https://e.com/a?utm_source=q&amp;ref=1#frag</link><guid>g1</guid><itunes:duration xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">18:22</itunes:duration></item>
    <item><title>y</title><link>https://e.com/b</link><guid>g2</guid><itunes:duration>1:02:03</itunes:duration></item>
    <item><title>z</title><link>https://e.com/c</link><guid>g3</guid><itunes:duration>300</itunes:duration></item>
  </channel></rss>`
  const { items } = parseFeed(xml)
  assert.equal(items[0].url, 'https://e.com/a')
  assert.equal(items[0].duration_sec, 1102)
  assert.equal(items[1].duration_sec, 3723)
  assert.equal(items[2].duration_sec, 300)
})

test('垃圾输入返回空条目而不是抛异常', () => {
  for (const junk of ['', 'not xml at all', '<rss><channel></channel></rss>', '<?xml version="1.0"?><html><body>hi</body></html>']) {
    const r = parseFeed(junk)
    assert.ok(Array.isArray(r.items))
    assert.equal(r.items.length, 0)
  }
})

test('decode 处理命名与数字实体，非法实体原样留着', () => {
  assert.equal(decode('a&amp;b'), 'a&b')
  assert.equal(decode('&#95;'), '_')
  assert.equal(decode('&#x4f60;&#x597d;'), '你好')
  assert.equal(decode('&notanentity;'), '&notanentity;')
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test test/feed.test.js`
Expected: FAIL — `Cannot find module '../lib/feed.js'`

- [ ] **Step 5: 写 `lib/feed.js`**

```js
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TRACKING = /^(utm_|_ga$|_gl$|mc_|ref$|source$|fbclid$|gclid$|igshid$)/i

export function decode(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m
    }
    const k = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m
  })
}

export function stripTags(html) {
  if (html == null) return ''
  const noScript = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  return decode(noScript.replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim()
}

function unwrapCdata(v) {
  const t = v.trim()
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t)
  return m ? m[1] : t
}

function closeIndex(text, from, tag) {
  const openRe = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>`, 'gi')
  const closeRe = new RegExp(`</${esc(tag)}\\s*>`, 'gi')
  openRe.lastIndex = closeRe.lastIndex = from
  let depth = 1
  while (true) {
    const o = openRe.exec(text)
    const c = closeRe.exec(text)
    if (!c) return -1
    if (o && o.index < c.index) { depth++; openRe.lastIndex = o.index + 1; continue }
    depth--
    if (depth === 0) return c.index
    closeRe.lastIndex = c.index + 1
  }
}

function blocks(text, tag) {
  const out = []
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>`, 'gi')
  let m
  while ((m = re.exec(text))) {
    const innerStart = m.index + m[0].length
    const innerEnd = closeIndex(text, innerStart, tag)
    if (innerEnd < 0) { re.lastIndex = innerStart; continue }
    out.push(text.slice(innerStart, innerEnd))
    re.lastIndex = innerEnd + tag.length + 3
  }
  return out
}

function selfClosingAttr(block, tag, attr) {
  const re = new RegExp(`<${esc(tag)}\\b([^>]*)/?>`, 'i')
  const m = re.exec(block)
  if (!m) return null
  const a = new RegExp(`\\b${esc(attr)}\\s*=\\s*"([^"]*)"|\\b${esc(attr)}\\s*=\\s*'([^']*)'`, 'i').exec(m[1])
  return a ? decode(a[1] ?? a[2]) : null
}

function field(block, tag) {
  const m = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'i').exec(block)
  if (m) return unwrapCdata(m[1])
  const self = new RegExp(`<${esc(tag)}\\b[^>]*/>`, 'i').exec(block)
  return self ? '' : null
}

function textOf(block, ...tags) {
  for (const t of tags) {
    const raw = field(block, t)
    if (raw != null && stripTags(raw) !== '') return stripTags(raw)
  }
  return null
}

function htmlOf(block, ...tags) {
  for (const t of tags) {
    const raw = field(block, t)
    if (raw != null && raw.trim() !== '') {
      const hasTags = /<[a-zA-Z][^>]*>/.test(raw)
      return hasTags ? decode(raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')) : raw
    }
  }
  return null
}

function allTags(block, tag) {
  const out = []
  for (const b of [block]) {
    const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'gi')
    let m
    while ((m = re.exec(b))) {
      const term = /\bterm\s*=\s*"([^"]*)"/i.exec(m[0])
      out.push(term ? decode(term[1]) : stripTags(unwrapCdata(m[1])))
    }
  }
  return out.filter(Boolean)
}

function parseDate(v) {
  if (!v) return null
  const s = String(v).trim().replace(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/, '$1$2Z')
  const iso = /^[\d-]+$/.test(s) ? null : s
  const t = Date.parse(iso || s)
  return Number.isFinite(t) ? t : null
}

export function parseDuration(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').filter(Boolean)
  if (!parts.length || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null
  const nums = parts.map(Number)
  let sec = 0
  for (const n of nums) sec = sec * 60 + n
  return sec
}

export function cleanUrl(u) {
  if (!u) return null
  let out = String(u).trim().replace(/^https?:\/\//, m => m).split('#')[0]
  if (/[?&]/.test(out)) {
    const [base, qs] = out.split('?')
    const kept = qs.split('&').filter(kv => kv && !TRACKING.test(kv.split('=')[0]))
    out = kept.length ? `${base}?${kept.join('&')}` : base
  }
  return out.replace(/\/$/, '')
}

function pickLink(block) {
  const rss = field(block, 'link')
  if (rss != null && rss.trim() !== '') return cleanUrl(stripTags(rss))
  const entries = block.match(/<link\b[^>]*>/gi) || []
  let fallback = null
  for (const tag of entries) {
    const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(tag)
    if (!href) continue
    const url = decode(href[1] ?? href[2])
    const rel = /rel\s*=\s*"([^"]*)"/i.exec(tag)
    if (!rel || rel[1] === 'alternate') return cleanUrl(url)
    fallback ??= cleanUrl(url)
  }
  return fallback
}

function pickThumb(block, bodyHtml) {
  const media = new RegExp(`<media:thumbnail\\b[^>]*\\burl\\s*=\\s*"([^"]*)"`, 'i').exec(block)
    || new RegExp(`<image\\b[^>]*\\burl\\s*=\\s*"([^"]*)"`, 'i').exec(block)
  if (media) return decode(media[1])
  const img = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(bodyHtml || '')
  return img ? decode(img[1]) : null
}

export function parseFeed(xml) {
  const text = String(xml ?? '')
  const isAtom = /<feed[\s>]/i.test(text)
  const isRss = /<rss[\s>]/i.test(text)
  const format = isAtom ? 'atom' : isRss ? 'rss' : 'unknown'
  const feedTitle = textOf(text, 'title')
  const rawItems = isAtom ? blocks(text, 'entry') : isRss ? blocks(text, 'item') : []
  const items = rawItems.map(b => {
    const bodyHtml = htmlOf(b, isAtom ? 'content' : 'content:encoded', 'description', 'summary')
    const summaryHtml = htmlOf(b, 'description', 'summary')
    const guid = textOf(b, 'guid', 'id')
    const url = pickLink(b)
    return {
      external_id: guid || url || null,
      url,
      title: textOf(b, 'title'),
      author: textOf(b, isAtom ? 'name' : 'author', 'dc:creator', 'creator')
        || (isAtom ? textOf(/<author[\s\S]*?<\/author>/i.exec(b)?.[0] ?? '', 'name') : null),
      published_at: parseDate(textOf(b, 'pubDate', 'published', 'updated', 'dc:date', 'date')),
      body_html: bodyHtml,
      summary_html: summaryHtml && summaryHtml !== bodyHtml ? summaryHtml : null,
      thumb: pickThumb(b, bodyHtml),
      duration_sec: parseDuration(textOf(b, 'itunes:duration', 'duration')),
      tags: [...new Set([...allTags(b, 'category'), ...allTags(b, 'media:keywords')])]
    }
  }).filter(i => i.title && (i.url || i.external_id))
  return { format, feed_title: feedTitle, items }
}
```

注意 `htmlOf` 里那段 `&lt;` → `<` 的还原只为 Atom 的 `content type="html"` 存在；若上游又叠了一层转义，测试里的 `stripTags(items[0].body_html)` 断言会先炸，按测试为准修，不要顺手放宽断言。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/feed.test.js`
Expected: PASS 6 tests。若 `selfClosingAttr` 未被使用导致 lint 抱怨，删掉它而不是留着。

- [ ] **Step 7: 提交**

```bash
git add lib/feed.js test/feed.test.js test/fixtures/
git commit -m "feat: RSS2 与 Atom 的容错 feed 解析器"
```

---

## Task 4: 并发池与 rss 适配器（错误分类、失败不推进游标）

**Files:**
- Create: `lib/pool.js`
- Create: `lib/adapters/rss.js`
- Create: `lib/adapters/index.js`
- Test: `test/pool.test.js`
- Test: `test/adapters-rss.test.js`

**Interfaces:**
- Consumes: `lib/feed.js::parseFeed`（Task 3）
- Produces:
  - `runJobs(jobs, { limit, timeoutMs, retries, run }) → JobResult[]`，`JobResult = { job, ok, value, error, error_class }`
  - `classifyError(err) → 'timeout' | 'network' | 'http' | 'parse' | 'empty' | 'unknown'`
  - `rssAdapter.fetch(source, { since, signal, fetchImpl }) → Promise<RawItem[]>`
  - `ADAPTERS = { rss: rssAdapter }`、`adapterFor(type) → adapter | null`
  - `RawItem`（后续所有适配器的统一产出形状）:

```js
{
  source_id, source_type, feed_title,
  external_id, url, title, author,
  published_at,          // ms | null
  body_html, summary_html, thumb, duration_sec, tags,
  fetched_at             // ms，由适配器盖章
}
```

- [ ] **Step 1: 写失败的测试 `test/pool.test.js`**

```js
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

test('超时按 timeout 分类并重试 1 次后失败', async () => {
  let calls = 0
  const res = await runJobs([{ id: 'slow' }], {
    limit: 1, timeoutMs: 20, retries: 1,
    run: () => { calls++; return new Promise(() => {}) }   // 永不 settle
  })
  assert.equal(res[0].ok, false)
  assert.equal(res[0].error_class, 'timeout')
  assert.equal(calls, 2)                                    // 1 次原始 + 1 次重试
})

test('重试成功就不算失败，且不超过 1 次重试', async () => {
  let calls = 0
  const res = await runJobs([{ id: 'flaky' }], {
    limit: 1, timeoutMs: 500, retries: 1,
    run: async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return 'ok' }
  })
  assert.equal(res[0].ok, true)
  assert.equal(res[0].value, 'ok')
  assert.equal(calls, 2)
})

test('第三次失败不再重试（上限 1 次）', async () => {
  let calls = 0
  await runJobs([{ id: 'dead' }], {
    limit: 1, timeoutMs: 500, retries: 1,
    run: async () => { calls++; throw new Error('boom') }
  })
  assert.equal(calls, 2)
})

test('错误分类', () => {
  const t = new Error('x'); t.name = 'TimeoutError'
  assert.equal(classifyError(t), 'timeout')
  const n = new TypeError('fetch failed')
  assert.equal(classifyError(n), 'network')
  const h = Object.assign(new Error('403'), { status: 403 })
  assert.equal(classifyError(h), 'http')
  const e = Object.assign(new Error('无条目'), { empty: true })
  assert.equal(classifyError(e), 'empty')
  const p = Object.assign(new Error('x'), { parse: true })
  assert.equal(classifyError(p), 'parse')
  assert.equal(classifyError(new Error('?')), 'unknown')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/pool.test.js`
Expected: FAIL — `Cannot find module '../lib/pool.js'`

- [ ] **Step 3: 写 `lib/pool.js`**

```js
export function classifyError(err) {
  if (!err) return 'unknown'
  if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return 'timeout'
  if (err.status) return 'http'
  if (err.empty) return 'empty'
  if (err.parse) return 'parse'
  if (err instanceof TypeError) return 'network'        // fetch failed / Failed to fetch
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|fetch failed/i.test(err.message || '')) return 'network'
  return 'unknown'
}

async function attempt(promiseFactory, timeoutMs) {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => { const e = new Error(`超过 ${timeoutMs}ms`); e.name = 'TimeoutError'; rej(e) }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(promiseFactory), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function runJobs(jobs, { limit = 4, timeoutMs = 20000, retries = 1, run }) {
  const results = new Array(jobs.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= jobs.length) return
      const job = jobs[i]
      let error = null
      let ok = false
      let value = null
      for (let tries = 0; tries <= retries; tries++) {
        try {
          value = await attempt(() => run(job, { index: i, retry: tries }), timeoutMs)
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length || 1)) }, worker))
  return results
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/pool.test.js`
Expected: PASS 5 tests

- [ ] **Step 5: 写失败的测试 `test/adapters-rss.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rssAdapter, adapterFor } from '../lib/adapters/index.js'

const fx = f => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f), 'utf8')
const source = { id: 'blog-a', type: 'rss', url: 'https://example.substack.com/feed', label: 'Naval Notes' }

test('正常抓取：产出 RawItem，fetched_at 盖章，feed_title 带上', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'] })
    return { ok: true, status: 200, text: async () => fx('substack.xml') }
  }
  const items = await rssAdapter.fetch(source, { since: null, fetchImpl, now: () => 1730000000000 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, source.url)
  assert.match(calls[0].ua, /^baleen\//)
  assert.equal(items.length, 2)
  assert.equal(items[0].source_id, 'blog-a')
  assert.equal(items[0].feed_title, 'Naval Notes')
  assert.equal(items[0].fetched_at, 1730000000000)
  assert.equal(items[0].external_id, 'rss-33771')
})

test('非 2xx 抛带 status 的错（会被分类成 http）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' })
  await assert.rejects(() => rssAdapter.fetch(source, { since: null, fetchImpl }), e => e.status === 403)
})

test('解析出 0 条抛 empty，不算成功（游标不得推进）', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html><body>no feed</body></html>' })
  await assert.rejects(() => rssAdapter.fetch(source, { since: null, fetchImpl }), e => e.empty === true)
})

test('since 只过滤"明确更旧"的条目；没有时间的条目留着交给去重', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => fx('substack.xml') })
  const since = new Date('2026-10-21T12:00:00Z').getTime()
  const items = await rssAdapter.fetch(source, { since, fetchImpl })
  assert.equal(items.length, 1)                                        // 第一条 pubDate 06:00 GMT 早于 since → 滤掉
  assert.equal(items[0].external_id, 'https://example.substack.com/p/summary-only')  // 留下的是无时间那条，guid 缺失退到 url
})

test('adapterFor 只认注册过的类型', () => {
  assert.equal(adapterFor('rss'), rssAdapter)
  assert.equal(adapterFor('bili'), null)
  assert.equal(adapterFor('B站'), null)
})
```

上面那条 `since` 测试的依据是：fixture 里第一条的 `pubDate` 是 `Wed, 21 Oct 2026 06:00:00 GMT`，比 `since`（当天中午）更早，所以被过滤掉；第二条没有 `pubDate`，**适配器不猜测时间、保留它，交给去重和预筛处理**。

- [ ] **Step 6: 跑测试确认失败**

Run: `node --test test/adapters-rss.test.js`
Expected: FAIL — `Cannot find module '../lib/adapters/index.js'`

- [ ] **Step 7: 写 `lib/adapters/rss.js`**

```js
import { parseFeed } from '../feed.js'

const VERSION = '0.1.0'
export const type = 'rss'

export async function fetch(source, { since = null, signal, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const res = await fetchImpl(source.url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': `baleen/${VERSION} (+local; rss)`,
      Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5'
    }
  })
  if (!res?.ok) {
    const e = new Error(`HTTP ${res?.status ?? '?'}`)
    e.status = res?.status ?? 0
    throw e
  }
  const xml = await res.text()
  const parsed = parseFeed(xml)
  if (!parsed.items.length) {
    const e = new Error(`feed 无条目（format=${parsed.format}）`)
    e.empty = true
    throw e
  }
  const stamped = now()
  return parsed.items
    .filter(i => !(i.published_at != null && since != null && i.published_at <= since))
    .map(i => ({
      source_id: source.id,
      source_type: type,
      feed_title: parsed.feed_title,
      external_id: i.external_id,
      url: i.url,
      title: i.title,
      author: i.author,
      published_at: i.published_at,
      body_html: i.body_html,
      summary_html: i.summary_html,
      thumb: i.thumb,
      duration_sec: i.duration_sec,
      tags: i.tags,
      fetched_at: stamped
    }))
}

export const rssAdapter = { type, fetch }
```

- [ ] **Step 8: 写 `lib/adapters/index.js`**

```js
import { rssAdapter } from './rss.js'

export const ADAPTERS = { rss: rssAdapter }
export { rssAdapter }
export function adapterFor(type) {
  return ADAPTERS[String(type ?? '').toLowerCase()] ?? null
}
```

- [ ] **Step 9: 跑测试确认通过并提交**

Run: `node --test "test/*.test.js"`
Expected: 全绿（此时 `since` 那条断言已按 Step 5 的说明改正）

```bash
git add lib/pool.js lib/adapters/ test/pool.test.js test/adapters-rss.test.js
git commit -m "feat: 并发池与 rss 适配器，失败分类且不推进游标"
```

---

## Task 5: normalize（kind、body_state、命中理由与得分）

**Files:**
- Create: `lib/normalize.js`
- Test: `test/normalize.test.js`

**Interfaces:**
- Consumes: `lib/feed.js::stripTags`、Task 4 的 `RawItem`、Task 2 的 `pref`
- Produces:
  - `normalize(raw, source, pref, now?) → Draft`，`Draft` 是可直接插进 `items` 的扁平对象（字段名同 DDL）
  - `matchThemes(rawText, pref) → { hitKeywords, score, rejected, reasons }`
  - `inferBodyState(raw) → body_state`
  - `inferKind(source, raw) → 'video' | 'article' | 'note'`

- [ ] **Step 1: 写失败的测试 `test/normalize.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, matchThemes, inferBodyState, inferKind } from '../lib/normalize.js'

const pref = {
  themes: [
    { group: 'AI 工具', must: ['DSH'], any: ['MCP', '智能体'], never: ['盘点合集'], weight: 1.0 },
    { group: '考研', any: ['政策过程'], weight: 0.8 }
  ],
  follow: { feeds: ['https://example.substack.com/feed'] },
  redlines: ['引流私聊'],
  tuning: { source_delta: { 'blog-a': 0.3 } },
  sources: [{ id: 'blog-a', type: 'rss', url: 'https://example.substack.com/feed', weight: 0.8 }]
}
const src = pref.sources[0]
const base = {
  source_id: 'blog-a', source_type: 'rss', feed_title: 'Naval Notes',
  external_id: 'e1', url: 'https://e.com/1', title: 'DSH 里的 MCP 怎么接', author: '桉',
  published_at: 1000, body_html: '<p>' + '内容'.repeat(200) + '</p>', summary_html: '短', thumb: null,
  duration_sec: null, tags: ['工具'], fetched_at: 2000
}

test('正文够长判 full，只有摘要判 summary_only，两者都空判 missing', () => {
  assert.equal(inferBodyState(base), 'full')
  assert.equal(inferBodyState({ ...base, body_html: null }), 'summary_only')
  assert.equal(inferBodyState({ ...base, body_html: null, summary_html: null }), 'missing')
  assert.equal(inferBodyState({ ...base, body_html: '<p>只有几个字</p>' }), 'summary_only')
})

test('rss 源默认 article；有 duration 或有视频类 id 时是 video；note 只由后续平台适配器给', () => {
  assert.equal(inferKind(src, base), 'article')
  assert.equal(inferKind(src, { ...base, duration_sec: 120 }), 'video')
  assert.equal(inferKind({ id: 'x', type: 'bili' }, base), 'video')
})

test('命中理由是人能读的一句话，且带上组名', () => {
  const d = normalize(base, src, pref, () => 9000)
  const m = JSON.parse(d.match_json)
  assert.ok(m.hitKeywords.includes('DSH'))
  assert.ok(m.hitKeywords.includes('MCP'))
  assert.equal(m.groups[0], 'AI 工具')
  assert.match(m.reason, /命中.*DSH/)
  assert.equal(d.prefilter_score > 0, true)
  assert.equal(d.status, 'new')
  assert.equal(d.kind, 'article')
  assert.equal(d.body_state, 'full')
  assert.equal(d.time_estimated, 0)     // 有真 pubDate → 不估算；发布时间缺失时才是 1
})

test('never 词直接把条目判死，redlines 同理，且理由写清是哪一条', () => {
  const a = matchThemes('DSH 盘点合集 好用', pref)
  assert.equal(a.rejected, true)
  assert.match(a.reason, /never/)
  const b = matchThemes('MCP 教程，文末引流私聊', pref)
  assert.equal(b.rejected, true)
  assert.match(b.reason, /redline/)
})

test('全部不命中时得分为 0，不是负数', () => {
  const m = matchThemes('与任何组无关的一句话', pref)
  assert.equal(m.rejected, false)
  assert.equal(m.score, 0)
})

test('follow 与 tuning 都进得分，且顺序可复现', () => {
  const withFollow = normalize({ ...base, title: '无关标题' }, src, pref, () => 9000)
  const s1 = JSON.parse(withFollow.match_json).score_follow
  assert.equal(typeof s1, 'number')
  assert.equal(withFollow.prefilter_score, normalize(base, src, pref, () => 9000).prefilter_score)
})
```

`time_estimated` 的语义是"**发布时间是猜的**"：只有 `published_at` 为 null 才置 1。


- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/normalize.test.js`
Expected: FAIL — `Cannot find module '../lib/normalize.js'`

- [ ] **Step 3: 写 `lib/normalize.js`**

```js
import { stripTags, cleanUrl } from './feed.js'

const FULL_MIN_CHARS = 400
const VIDEO_ID_RE = /^(BV[0-9a-zA-Z]{10}|youtu\.?be.+/

export function inferBodyState(raw) {
  const full = stripTags(raw.body_html)
  const sum = stripTags(raw.summary_html)
  if (raw.subtitle_text) return 'subtitle'
  if (raw.transcript_text) return 'transcribed'
  if (full.length >= FULL_MIN_CHARS && full.length >= sum.length * 1.4) return 'full'
  if (sum.length || full.length) return 'summary_only'
  if (raw.hardsub_hint) return 'burned_in'
  return 'missing'
}

export function inferKind(source, raw) {
  if (raw.note_type === 'video') return 'video'
  if (raw.note_type === 'image') return 'note'
  if (source?.type === 'bili' || source?.type === 'yt') return 'video'
  if (Number.isFinite(raw.duration_sec) && raw.duration_sec > 0) return 'video'
  return 'article'
}

export function matchThemes(text, pref) {
  const hay = String(text ?? '').toLowerCase()
  const hitKeywords = []
  const groups = []
  let score = 0
  for (const t of pref.themes ?? []) {
    const w = Number.isFinite(t.weight) ? t.weight : 1
    const never = (t.never ?? []).filter(k => k && hay.includes(String(k).toLowerCase()))
    if (never.length) return { rejected: true, reason: `never「${never[0]}」`, hitKeywords: [], groups: [], score: 0 }
    const mustOk = (t.must ?? []).every(k => hay.includes(String(k).toLowerCase()))
    const anyHits = (t.any ?? []).filter(k => k && hay.includes(String(k).toLowerCase()))
    if (!mustOk || !anyHits.length) continue
    for (const k of [...(t.must ?? []), ...anyHits]) if (!hitKeywords.includes(k)) hitKeywords.push(k)
    groups.push(t.group)
    score += w * (mustOk && (t.must ?? []).length ? 1 : 0.5) + anyHits.length * 0.2 * w
  }
  const redline = (pref.redlines ?? []).find(k => k && hay.includes(String(k).toLowerCase()))
  if (redline) return { rejected: true, reason: `redline「${redline}」`, hitKeywords: [], groups: [], score: 0 }
  const reason = hitKeywords.length
    ? `命中 ${hitKeywords.slice(0, 3).join(' / ')}${groups.length ? `（${groups.join('、')}）` : ''}`
    : '未命中任何主题组'
  return { rejected: false, reason, hitKeywords, groups, score: Math.round(score * 100) / 100 }
}

export function normalize(raw, source, pref, now = Date.now) {
  const haystack = [raw.title, raw.tags?.join(' '), stripTags(raw.body_html ?? ''), stripTags(raw.summary_html ?? '')]
    .filter(Boolean).join('\n')
  const m = matchThemes(haystack, pref)
  const delta = pref?.tuning?.source_delta?.[raw.source_id] ?? 0
  const srcWeight = Number.isFinite(source?.weight) ? source.weight : 1
  const followed = (pref?.follow?.feeds ?? []).includes(cleanUrl(raw.url) ?? raw.url)
    || (pref?.follow?.[source?.type] ?? []).some(a => a && String(a) === String(raw.author_id ?? raw.author))
  const score_follow = followed ? 0.6 : 0
  const stale = raw.published_at != null
    && (now() - raw.published_at) > (pref?.limits?.max_age_days ?? 14) * 86400000
  return {
    source_id: raw.source_id,
    external_id: raw.external_id ?? raw.url,
    kind: inferKind(source, raw),
    title: String(raw.title ?? '').slice(0, 300),
    url: raw.url ?? `x-baleen://stub/${raw.source_id}/${raw.external_id ?? ''}`,
    author: raw.author ?? null,
    author_id: raw.author_id ?? null,
    published_at: raw.published_at ?? null,
    time_estimated: raw.published_at == null ? 1 : 0,
    fetched_at: raw.fetched_at ?? now(),
    thumb: raw.thumb ?? null,
    duration_sec: raw.duration_sec ?? null,
    stats_json: raw.stats ? JSON.stringify(raw.stats) : null,
    tags_json: raw.tags?.length ? JSON.stringify(raw.tags) : null,
    locale: raw.locale ?? null,
    body_text: stripTags(raw.body_html ?? raw.summary_html ?? '') || null,
    body_state: inferBodyState(raw),
    match_json: JSON.stringify({
      hitKeywords: m.hitKeywords, groups: m.groups, reason: m.reason,
      weight: Math.round((srcWeight + delta) * 100) / 100, score_theme: m.score, score_follow,
      rejected: m.rejected
    }),
    prefilter_score: Math.round((m.score + score_follow + srcWeight + delta) * 100) / 100,
    status: 'new',
    rejected_by_theme: m.rejected ? 1 : 0,
    stale
  }
}
```

`normalize` 返回的 `rejected_by_theme` 与 `stale` 不是 DDL 列，Task 6 的 `upsertItem` 必须在插入前把它们剥掉（放在 `match_json` 里即可），这是刻意的：判断与预筛读的是 draft，库只存列。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/normalize.test.js`
Expected: PASS 6 tests（第 3 条测试的 `time_estimated` 断言已按 Step 1 的说明改为 `0`）

- [ ] **Step 5: 提交**

```bash
git add lib/normalize.js test/normalize.test.js
git commit -m "feat: 条目规范化、kind 与 body_state 推断、命中理由"
```

---

## Task 6: 两级去重、入库与查询语句

**Files:**
- Create: `lib/dedup.js`
- Modify: `lib/store.js`（追加查询函数，不动已有四个）
- Test: `test/dedup.test.js`
- Test: `test/store-queries.test.js`

**Interfaces:**
- Consumes: `lib/store.js`（Task 1）、`lib/feed.js::cleanUrl`、Task 5 的 `Draft`
- Produces（后续 runner 只依赖这些）:
  - `putDraft(db, draft, now?) → { id, action: 'insert' | 'update' | 'skip_seen' | 'duplicate', reason? }`
  - `findDuplicate(db, draft, now?) → { id, why } | null`
  - store 侧：`getItemByKey` `setStatus` `candidates` `createRun` `patchRun` `finishRun` `getCursor` `setCursor` `upsertSource` `listSources` `counts`
  - 游标一律以 ISO 字符串存进 `meta`（键 `cursor:<sourceId>`），避免各处混用数字与字符串。

- [ ] **Step 1: 写失败的测试 `test/store-queries.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, migrate, setCursor, getCursor, upsertSource, listSources, createRun, patchRun, finishRun, candidates, setStatus, counts, getItemByKey } from '../lib/store.js'

const draft = (over = {}) => ({
  source_id: 's1', external_id: 'e1', kind: 'article', title: 't', url: 'https://e.com/1',
  body_state: 'full', status: 'new', fetched_at: 1000, prefilter_score: 1.0,
  published_at: 900, match_json: '{}', ...over
})

test('游标按源存取，可覆盖', () => {
  const { db } = openStore(':memory:'); migrate(db)
  assert.equal(getCursor(db, 's1'), null)
  setCursor(db, 's1', '2026-10-21T00:00:00.000Z')
  setCursor(db, 's1', '2026-10-22T00:00:00.000Z')
  assert.equal(getCursor(db, 's1'), '2026-10-22T00:00:00.000Z')
  db.close()
})

test('upsertSource 幂等且不覆盖运行态（cursor / last_error / last_ok_at）', () => {
  const { db } = openStore(':memory:'); migrate(db)
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f', enabled: true, interval_min: 60, weight: 0.8 })
  setCursor(db, 's1', '2026-10-22T00:00:00.000Z')
  upsertSource(db, { id: 's1', type: 'rss', url: 'https://e.com/f2', enabled: true, interval_min: 120, weight: 0.8 })
  const [s] = listSources(db)
  assert.equal(s.url, 'https://e.com/f2')
  assert.equal(s.interval_min, 120)
  assert.equal(getCursor(db, 's1'), '2026-10-22T00:00:00.000Z')
  db.close()
})

test('run 生命周期：create → patch → finish，status 可读', () => {
  const { db } = openStore(':memory:'); migrate(db)
  const id = createRun(db, 'manual', () => 1000)
  patchRun(db, id, { candidates: 3, per_source: { s1: { fetched: 3, ok: true } } })
  finishRun(db, id, { status: 'partial', error: 's2 超时' }, () => 2000)
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
  assert.equal(r.status, 'partial')
  assert.equal(r.candidates, 3)
  assert.equal(r.trigger, 'manual')
  assert.equal(r.finished_at, 2000)
  assert.deepEqual(JSON.parse(r.per_source_json).s1, { fetched: 3, ok: true })
  db.close()
})

test('candidates 按 prefilter_score 降序取，只取 status=new', () => {
  const { db } = openStore(':memory:'); migrate(db)
  const ins = db.prepare(`INSERT INTO items (source_id, external_id, kind, title, url, body_state, status, fetched_at, prefilter_score, published_at)
    VALUES (@source_id, @external_id, @kind, @title, @url, @body_state, @status, @fetched_at, @prefilter_score, @published_at)`)
  ins.run(draft({ external_id: 'a', prefilter_score: 1 }))
  ins.run(draft({ external_id: 'b', prefilter_score: 9 }))
  ins.run(draft({ external_id: 'c', prefilter_score: 5, status: 'judged' }))
  const got = candidates(db, 2)
  assert.deepEqual(got.map(r => r.external_id), ['b', 'a'])
  assert.deepEqual(counts(db), { new: 1, judged: 1, archived: 0, total: 3 })
  setStatus(db, got[0].id, 'archived', 'stale')
  assert.equal(getItemByKey(db, 's1', 'b').archived_reason, 'stale')
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/store-queries.test.js`
Expected: FAIL — `does not provide an export named 'setCursor'`

- [ ] **Step 3: 给 `lib/store.js` 追加查询（只加不改）**

```js
const INSERT_ITEM = `INSERT INTO items (
  source_id, external_id, kind, title, url, author, author_id, published_at, time_estimated,
  fetched_at, thumb, duration_sec, stats_json, tags_json, locale, body_text, body_state,
  match_json, prefilter_score, status
) VALUES (
  @source_id, @external_id, @kind, @title, @url, @author, @author_id, @published_at, @time_estimated,
  @fetched_at, @thumb, @duration_sec, @stats_json, @tags_json, @locale, @body_text, @body_state,
  @match_json, @prefilter_score, @status
)`

const ITEM_COLS = `i.id, i.source_id, i.external_id, i.kind, i.title, i.url, i.author, i.published_at,
  i.time_estimated, i.fetched_at, i.thumb, i.duration_sec, i.tags_json, i.body_state, i.match_json,
  i.prefilter_score, i.status, i.archived_reason, i.verdict_tier, i.feedback`

export function getItemByKey(db, sourceId, externalId) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items i WHERE source_id = ? AND external_id = ?`).get(sourceId, externalId) ?? null
}

export function getItemById(db, id) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items i WHERE id = ?`).get(id) ?? null
}

export function findByUrl(db, url, sinceMs) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items i WHERE url = ? AND fetched_at >= ? ORDER BY id ASC LIMIT 1`).all(url, sinceMs)[0] ?? null
}

export function findByTitleAuthor(db, title, author, sinceMs) {
  return db.prepare(
    `SELECT ${ITEM_COLS} FROM items i WHERE lower(i.title) = lower(?) AND ifnull(i.author,'') = ifnull(?, '') AND i.fetched_at >= ? ORDER BY id ASC LIMIT 1`
  ).all(title, author, sinceMs)[0] ?? null
}

export function setStatus(db, id, status, reason = null) {
  db.prepare('UPDATE items SET status = ?, archived_reason = COALESCE(?, archived_reason) WHERE id = ?').run(status, reason, id)
}

export function touchBody(db, id, patch) {
  const sets = [], vals = []
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v) }
  if (!sets.length) return
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function candidates(db, limit) {
  return db.prepare(`SELECT ${ITEM_COLS} FROM items i WHERE status = 'new'
    ORDER BY prefilter_score DESC, published_at DESC, id ASC LIMIT ?`).all(limit)
}

export function counts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all()
  const out = { new: 0, judged: 0, archived: 0, total: 0 }
  for (const r of rows) { if (r.status in out) out[r.status] = r.n; out.total += r.n }
  return out
}

export function listItems(db, { status = null, kind = null, tier = null, since = null, limit = 100, offset = 0 } = {}) {
  const where = [], vals = []
  if (status) { where.push('i.status = ?'); vals.push(status) }
  if (kind) { where.push('i.kind = ?'); vals.push(kind) }
  if (tier) { where.push('i.verdict_tier = ?'); vals.push(tier) }
  if (since) { where.push('i.fetched_at >= ?'); vals.push(since) }
  const sql = `SELECT ${ITEM_COLS} FROM items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.fetched_at DESC, i.id DESC LIMIT ? OFFSET ?`
  return db.prepare(sql).all(...vals, limit, offset)
}

export function createRun(db, trigger, now = Date.now) {
  const r = db.prepare("INSERT INTO runs (started_at, trigger, status) VALUES (?, ?, 'running')").run(now(), trigger)
  return Number(r.lastInsertRowid)
}

export function patchRun(db, runId, patch) {
  const map = { candidates: 'candidates', judged: 'judged', per_source: 'per_source_json', model_run_id: 'model_run_id', error: 'error' }
  const sets = [], vals = []
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k]) continue
    sets.push(`${map[k]} = ?`)
    vals.push(k === 'per_source' ? JSON.stringify(v ?? {}) : v)
  }
  if (!sets.length) return
  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, runId)
}

export function finishRun(db, runId, patch = {}, now = Date.now) {
  patchRun(db, runId, patch)
  db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run(patch.status ?? 'done', now(), runId)
}

export function lastRun(db) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null
}

export function getCursor(db, sourceId) { return getMeta(db, `cursor:${sourceId}`) }
export function setCursor(db, sourceId, iso) { setMeta(db, `cursor:${sourceId}`, iso) }

export function upsertSource(db, s) {
  db.prepare(`INSERT INTO sources (id, type, url, label, enabled, interval_min, weight)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, url = excluded.url, label = excluded.label,
      enabled = excluded.enabled, interval_min = excluded.interval_min, weight = excluded.weight`)
    .run(s.id, s.type, s.url ?? null, s.label ?? null, s.enabled === false ? 0 : 1, s.interval_min ?? 720, s.weight ?? 1.0)
}

export function listSources(db) {
  return db.prepare('SELECT * FROM sources ORDER BY id').all()
}

export function setSourceResult(db, id, { ok, error_class = null, error = null, at }) {
  db.prepare(`UPDATE sources SET last_error_class = ?, last_error = ?, last_ok_at = COALESCE(?, last_ok_at) WHERE id = ?`)
    .run(ok ? null : error_class, ok ? null : error, ok ? at : null, id)
}
```

- [ ] **Step 4: 写失败的测试 `test/dedup.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, migrate, getItemByKey } from '../lib/store.js'
import { putDraft, findDuplicate } from '../lib/dedup.js'

const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
const draft = (over = {}) => ({
  source_id: 's1', external_id: 'e1', kind: 'article', title: '为什么 RSS 还活着',
  url: 'https://e.com/a?utm_source=x', author: '桉', published_at: 1000, time_estimated: 0,
  fetched_at: 2000, body_state: 'full', body_text: 'x', match_json: '{}', prefilter_score: 1, status: 'new',
  tags_json: null, stats_json: null, thumb: null, duration_sec: null, locale: null, author_id: null, ...over
})
const DAY = 86400000

test('唯一键冲突且已判过 → skip_seen，不重复消耗判断', () => {
  const db = dbOf()
  const a = putDraft(db, draft(), () => 2000)
  assert.equal(a.action, 'insert')
  getItemByKey(db, 's1', 'e1') && db.prepare("UPDATE items SET status='judged' WHERE id=?").run(a.id)
  const b = putDraft(db, draft({ body_text: '更完整的一版' }), () => 3000)
  assert.equal(b.action, 'skip_seen')
  assert.equal(b.id, a.id)
  assert.equal(getItemByKey(db, 's1', 'e1').body_text, 'x')
})

test('同键但仍是 new → update，正文字段刷新', () => {
  const db = dbOf()
  const a = putDraft(db, draft({ body_text: '旧' }), () => 2000)
  const b = putDraft(db, draft({ body_text: '新' }), () => 3000)
  assert.equal(b.action, 'update')
  assert.equal(b.id, a.id)
  assert.equal(getItemByKey(db, 's1', 'e1').body_text, '新')
})

test('不同 external_id 但规范化 URL 相同、14 天内 → 新条被记为 duplicate', () => {
  const db = dbOf()
  const a = putDraft(db, draft({ external_id: 'g1' }), () => 2000)
  const b = putDraft(db, draft({ external_id: 'g2', url: 'https://e.com/a?utm_source=y' }), () => 2000 + DAY)
  assert.equal(b.action, 'duplicate')
  assert.equal(getItemByKey(db, 's1', 'g2').status, 'archived')
  assert.equal(getItemByKey(db, 's1', 'g2').archived_reason, 'duplicate:https://e.com/a')
  assert.notEqual(b.id, a.id)
})

test('同标题同作者跨源也算 duplicate；超 14 天不算', () => {
  const db = dbOf()
  putDraft(db, draft({ source_id: 's1' }), () => 2000)
  const late = putDraft(db, draft({ source_id: 's2', external_id: 'z' }), () => 2000 + 15 * DAY)
  assert.equal(late.action, 'insert')
  const near = putDraft(db, draft({ source_id: 's3', external_id: 'z2', url: 'https://other.com/1' }), () => 2000 + 15 * DAY + 1)
  assert.equal(near.action, 'duplicate')
})

test('findDuplicate 对空标题与空 URL 都不误判', () => {
  const db = dbOf()
  putDraft(db, draft({ title: '', url: 'https://e.com/q', external_id: 'x1' }), () => 2000)
  assert.equal(findDuplicate(db, draft({ title: '', url: 'https://e.com/other', external_id: 'x2' }), () => 2000), null)
  assert.equal(findDuplicate(db, draft({ title: '另一个', url: '', external_id: 'x3' }), () => 2000), null)
})
```

第 4 条测试的"超 14 天不算"里，`near` 用的是第三个源：先跑 15 天前的 `s2` 那条应插进去，再插 `s3` 时它相对 `s2` 在 1 毫秒内 → 判 duplicate。**执行时如果 `putDraft` 的时间基准写成 `fetched_at` 与 `now` 混用会不稳**，统一以 `now()` 作比较基准（`fetched_at >= now - 14*DAY`），断言不变。

- [ ] **Step 5: 写 `lib/dedup.js`**

```js
import { cleanUrl } from './feed.js'
import { getItemByKey, findByUrl, findByTitleAuthor, touchBody, setStatus } from './store.js'

const DAY = 86400000
const WINDOW = 14 * DAY

export function findDuplicate(db, draft, now = Date.now) {
  const since = Number(now()) - WINDOW
  const cu = cleanUrl(draft.url)
  if (cu) {
    const hit = findByUrl(db, cu, since)
    if (hit && hit.source_id !== draft.source_id) return { id: hit.id, why: `url:${cu}` }
    if (hit) return null
  }
  const title = String(draft.title ?? '').trim()
  if (title.length >= 8) {
    const hit2 = findByTitleAuthor(db, title, draft.author ?? null, since)
    if (hit2) return { id: hit2.id, why: `title-author` }
  }
  return null
}

export function putDraft(db, draft, now = Date.now) {
  const key = getItemByKey(db, draft.source_id, draft.external_id)
  if (key) {
    if (key.status === 'judged' || key.status === 'digest') return { id: key.id, action: 'skip_seen' }
    if (key.status === 'archived' && key.archived_reason !== 'duplicate') {
      return { id: key.id, action: 'skip_seen', reason: `archived:${key.archived_reason}` }
    }
    touchBody(db, key.id, {
      body_text: draft.body_text, body_state: draft.body_state, match_json: draft.match_json,
      prefilter_score: draft.prefilter_score, fetched_at: draft.fetched_at, thumb: draft.thumb,
      published_at: draft.published_at, time_estimated: draft.time_estimated, tags_json: draft.tags_json,
      status: key.status === 'duplicate' ? key.status : 'new'
    })
    return { id: key.id, action: 'update' }
  }
  const dup = findDuplicate(db, draft, now)
  if (dup) {
    const id = insert(db, draft)
    setStatus(db, id, 'archived', `duplicate:${dup.why}`)
    return { id, action: 'duplicate', reason: dup.why }
  }
  return { id: insert(db, draft), action: 'insert' }
}

function insert(db, d) {
  const row = {
    stats_json: null, tags_json: null, thumb: null, duration_sec: null, locale: null,
    author: null, author_id: null, published_at: null, time_estimated: 0, body_text: null,
    prefilter_score: 0, ...d
  }
  const r = db.prepare(`INSERT INTO items (
    source_id, external_id, kind, title, url, author, author_id, published_at, time_estimated, fetched_at,
    thumb, duration_sec, stats_json, tags_json, locale, body_text, body_state, match_json, prefilter_score, status
  ) VALUES (@source_id, @external_id, @kind, @title, @url, @author, @author_id, @published_at, @time_estimated, @fetched_at,
    @thumb, @duration_sec, @stats_json, @tags_json, @locale, @body_text, @body_state, @match_json, @prefilter_score, @status)`
  ).run(row)
  return Number(r.lastInsertRowid)
}
```

`insert` 里那份默认值对象是必需的：`node:sqlite` 的命名参数缺一个就抛，所以 Draft 的所有可选字段在插库前都要有值。

- [ ] **Step 6: 跑测试确认通过并提交**

Run: `node --test "test/*.test.js"`
Expected: 全绿

```bash
git add lib/store.js lib/dedup.js test/dedup.test.js test/store-queries.test.js
git commit -m "feat: 两级去重入库与库查询语句"
```

---

## Task 7: 本地预筛闸门（不调模型）

**Files:**
- Create: `lib/prefilter.js`
- Test: `test/prefilter.test.js`

**Interfaces:**
- Consumes: Task 5 的 `Draft`、Task 2 的 `pref`
- Produces: `gate(draft, pref, now?) → { pass: true } | { pass: false, reason, detail }`，`reason` 取自固定集合：
  `theme-reject` `no-body` `stale` `too-short` `skip-kind` `below-score`
  以及 `keep_flag`（不丢弃但要在汇报里可见的情形：`burned_in`）

- [ ] **Step 1: 写失败的测试 `test/prefilter.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, REASONS } from '../lib/prefilter.js'

const DAY = 86400000
const pref = { limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] }, min_score: 0.2 }
const d = (over = {}) => ({
  kind: 'article', body_state: 'full', duration_sec: null, published_at: 1000,
  prefilter_score: 1, match_json: '{"rejected":false}', ...over
})

test('固定原因集合可枚举，且不含自造词', () => {
  assert.deepEqual(REASONS, ['theme-reject', 'no-body', 'stale', 'too-short', 'skip-kind', 'below-score'])
})

test('主题 never 命中的条目丢弃并写 theme-reject', () => {
  const r = gate(d({ match_json: '{"rejected":true,"reason":"never「盘点合集」' + '"}' }), pref, () => 2000)
  assert.deepEqual(r, { pass: false, reason: 'theme-reject', detail: 'never「盘点合集」' })
})

test('missing 丢弃，burned_in 保留但打可见标记（两者不得合并）', () => {
  assert.equal(gate(d({ body_state: 'missing' }), pref, () => 2000).reason, 'no-body')
  const b = gate(d({ body_state: 'burned_in' }), pref, () => 2000)
  assert.equal(b.pass, true)
  assert.equal(b.keep_flag, 'burned_in')
})

test('超期丢弃且明细带天数', () => {
  const r = gate(d({ published_at: 0 }), { limits: { max_age_days: 14, min_duration_sec: 90 } }, () => 20 * DAY)
  assert.equal(r.pass, false)
  assert.equal(r.reason, 'stale')
  assert.match(r.detail, /20/)
})

test('短视频按时长丢弃；文章无时长不受影响', () => {
  const r = gate(d({ kind: 'video', duration_sec: 30 }), pref, () => 2000)
  assert.equal(r.reason, 'too-short')
  assert.equal(gate(d({ kind: 'article', duration_sec: null }), pref, () => 2000).pass, true)
})

test('skip_kinds 与低分', () => {
  assert.equal(gate(d({ kind: 'note' }), { ...pref, limits: { ...pref.limits, skip_kinds: ['note'] } }, () => 2000).reason, 'skip-kind')
  assert.equal(gate(d({ prefilter_score: 0.01 }), pref, () => 2000).reason, 'below-score')
})

test('published_at 为 null 时不按 stale 丢弃（缺失时间不该变成过期）', () => {
  assert.equal(gate(d({ published_at: null }), pref, () => 20 * DAY).pass, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/prefilter.test.js`
Expected: FAIL — `Cannot find module '../lib/prefilter.js'`

- [ ] **Step 3: 写 `lib/prefilter.js`**

```js
export const REASONS = ['theme-reject', 'no-body', 'stale', 'too-short', 'skip-kind', 'below-score']
const DAY = 86400000
const MIN_SCORE_DEFAULT = 0.2

export function gate(draft, pref, now = Date.now) {
  const limits = pref?.limits ?? {}
  const maxAge = Number.isFinite(limits.max_age_days) ? limits.max_age_days : 14
  const minDur = Number.isFinite(limits.min_duration_sec) ? limits.min_duration_sec : 90
  const minScore = Number.isFinite(pref?.min_score) ? pref.min_score : MIN_SCORE_DEFAULT
  let match = {}
  try { match = JSON.parse(draft.match_json ?? '{}') } catch { match = {} }

  if (match.rejected) return fail('theme-reject', match.reason || '命中排除词')
  if ((limits.skip_kinds ?? []).includes(draft.kind)) return fail('skip-kind', `kind=${draft.kind}`)
  if (draft.body_state === 'missing') return fail('no-body', '读不到内容')
  if (draft.published_at != null && Number(now()) - Number(draft.published_at) > maxAge * DAY) {
    return fail('stale', `${Math.floor((Number(now()) - Number(draft.published_at)) / DAY)} 天前`)
  }
  if (draft.kind === 'video' && Number.isFinite(draft.duration_sec) && draft.duration_sec < minDur) {
    return fail('too-short', `${draft.duration_sec}s < ${minDur}s`)
  }
  if (Number(draft.prefilter_score ?? 0) < minScore) return fail('below-score', `${draft.prefilter_score}`)
  if (draft.body_state === 'burned_in') return { pass: true, keep_flag: 'burned_in' }
  return { pass: true }
}

function fail(reason, detail) { return { pass: false, reason, detail } }
```

注意 `no-body` 只针对 `missing`。`summary_only` 与 `burned_in` 都放行——前者是 Medium 付费墙的常态，后者必须留在库里可见，否则你会把"读不到"当成"没内容"（spec §6.2）。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/prefilter.test.js`
Expected: PASS 7 tests

```bash
git add lib/prefilter.js test/prefilter.test.js
git commit -m "feat: 本地预筛闸门，missing 与 burned_in 分开处理"
```

---

## Task 8: runOnce 编排（八步里的 1–5）

**Files:**
- Create: `lib/jobs.js`
- Create: `lib/runner.js`
- Create: `test/helpers/fake-adapter.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: `listSources` `upsertSource` `setCursor` `getCursor` `createRun` `patchRun` `finishRun` `setSourceResult`（Task 6）、`adapterFor`（Task 4）、`normalize`（Task 5）、`putDraft`（Task 6）、`gate`（Task 7）、`runJobs`（Task 4）
- Produces:
  - `syncSources(db, pref) → void`（把 `preference.yaml` 的 sources 镜像进 `sources` 表；只增改，不删运行态）
  - `planJobs({ db, pref, now }) → Job[]`，`Job = { source, type, since, windowEnd }`，`since` 为 ms 或 null
  - `runOnce({ db, pref, now?, log?, fetchImpl?, adapters?, trigger? }) → { runId, status, stats }`，`stats = { fetched, inserted, updated, duplicate, archived, candidates, per_source }`
  - 日志行固定形状：`{ at, level, event, source_id?, run_id?, detail }`，`detail` 已脱敏

- [ ] **Step 1: 写 `test/helpers/fake-adapter.js`（契约测试替身，不发网络）**

```js
export function fakeAdapter(name, behaviors) {
  // behaviors: sourceId -> { items?: RawItem[], error?: Error & {status?: number, empty?: boolean} }
  const seen = []
  return {
    type: name,
    seen,
    async fetch(source, { since, signal }) {
      seen.push({ id: source.id, since, aborted: signal?.aborted ?? false })
      const b = behaviors[source.id] ?? { error: Object.assign(new Error('未配置'), { status: 500 }) }
      if (b.error) throw b.error
      return b.items ?? []
    }
  }
}

export function rawOf(sourceId, over = {}) {
  return {
    source_id: sourceId, source_type: 'rss', feed_title: 'F', external_id: over.external_id ?? `${sourceId}-x`,
    url: `https://e.com/${sourceId}`, title: 'DSH MCP 教程', author: '桉', published_at: 1500,
    body_html: '<p>' + '内容'.repeat(200) + '</p>', summary_html: '短', thumb: null, duration_sec: null,
    tags: [], fetched_at: 2000, ...over
  }
}

export const timeoutError = () => Object.assign(new Error('超过 20000ms'), { name: 'TimeoutError' })
```

- [ ] **Step 2: 写失败的测试 `test/runner.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { openStore, migrate, listSources, getCursor, candidates, counts } from '../lib/store.js'
import { runOnce, syncSources, planJobs } from '../lib/runner.js'
import { normalize } from '../lib/normalize.js'
import { fakeAdapter, rawOf, timeoutError } from './helpers/fake-adapter.js'

const pref = {
  themes: [{ group: 'AI', must: [], any: ['DSH', 'MCP'], never: ['盘点'], weight: 1 }],
  follow: { feeds: [] }, redlines: ['引流'], tuning: { source_delta: {} },
  schedule: { windows: ['00:00-23:59'], max_per_run: 5, max_per_day: 40 },
  limits: { max_age_days: 14, min_duration_sec: 90, skip_kinds: [] },
  sources: [
    { id: 'ok', type: 'rss', url: 'https://e.com/ok', enabled: true, interval_min: 60, weight: 1 },
    { id: 'bad', type: 'rss', url: 'https://e.com/bad', enabled: true, interval_min: 60, weight: 1 },
    { id: 'off', type: 'rss', url: 'https://e.com/off', enabled: false, interval_min: 60, weight: 1 }
  ]
}
const dbOf = () => { const { db } = openStore(':memory:'); migrate(db); return db }
const adapters = () => ({
  rss: fakeAdapter('rss', {
    ok: { items: [rawOf('ok', { external_id: 'a' }), rawOf('ok', { external_id: 'b' }), rawOf('ok', { external_id: 'c', title: '盘点来了', body_html: '<p>' + '字'.repeat(500) + '</p>' })] },
    bad: { error: timeoutError() }
  })
})

test('syncSources 镜像偏好但不删运行态，enabled 落库', () => {
  const db = dbOf()
  syncSources(db, pref)
  const rows = listSources(db)
  assert.deepEqual(rows.map(r => r.id).sort(), ['bad', 'off', 'ok'])
  assert.equal(rows.find(r => r.id === 'off').enabled, 0)
})

test('planJobs 只给启用的源，并带上该源游标', () => {
  const db = dbOf()
  syncSources(db, pref)
  const jobs = planJobs({ db, pref, now: () => 5000 })
  assert.deepEqual(jobs.map(j => j.source.id).sort(), ['bad', 'ok'])
  assert.equal(jobs[0].since, null)
  assert.equal(jobs[0].windowEnd, 5000)
})

test('一轮：好源入库、坏源不推进游标、never 条目被预筛丢弃', async () => {
  const db = dbOf()
  const { runId, status, stats } = await runOnce({ db, pref, now: () => 5000, adapters: adapters(), trigger: 'manual' })
  assert.equal(status, 'partial')
  assert.equal(stats.fetched, 3)
  assert.equal(stats.archived, 1)
  assert.equal(stats.candidates, 2)
  assert.equal(getCursor(db, 'ok'), new Date(5000).toISOString())
  assert.equal(getCursor(db, 'bad'), null)
  const per = JSON.parse(db.prepare('SELECT per_source_json FROM runs WHERE id=?').get(runId).per_source_json)
  assert.deepEqual(per.bad, { ok: false, fetched: 0, error_class: 'timeout' })
  assert.equal(per.ok.ok, true)
  const archived = db.prepare("SELECT archived_reason FROM items WHERE status='archived'").get()
  assert.match(archived.archived_reason, /^theme-reject/)
})

test('好源下一轮用游标过滤旧条目：同一条不再重复插入', async () => {
  const db = dbOf()
  const A = adapters()
  await runOnce({ db, pref, now: () => 5000, adapters: A })
  const B = fakeAdapter('rss', { ok: { items: [rawOf('ok', { external_id: 'a', published_at: 4000 })] }, bad: { items: [] } })
  await runOnce({ db, pref, now: () => 9000, adapters: { rss: B }, trigger: 'schedule' })
  assert.equal(B.seen[0].since, 5000)               // 上一轮游标被当作本轮 since
  assert.deepEqual(counts(db), { new: 2, judged: 0, archived: 1, total: 3 })   // c 被预筛归档，重复的 a 没新增
})

test('坏源恢复后补齐缺口：游标未推进所以旧条目这次能进来', async () => {
  const db = dbOf()
  await runOnce({ db, pref, now: () => 5000, adapters: adapters() })
  const fix = fakeAdapter('rss', { ok: { items: [] }, bad: { items: [rawOf('bad', { external_id: 'late' })] } })
  await runOnce({ db, pref, now: () => 9000, adapters: { rss: fix } })
  assert.equal(fix.seen[1].since, null)              // bad 从未成功，游标一直是 null
  assert.ok(db.prepare("SELECT id FROM items WHERE external_id='late'").get())
})

test('全部源失败 → failed；全部成功 → done', async () => {
  const db = dbOf()
  const all = fakeAdapter('rss', { ok: { error: timeoutError() }, bad: { error: timeoutError() } })
  const r = await runOnce({ db, pref, now: () => 5000, adapters: { rss: all } })
  assert.equal(r.status, 'failed')
  const db2 = dbOf()
  const okOnly = { rss: fakeAdapter('rss', { ok: { items: [] }, bad: { items: [] } }) }
  const r2 = await runOnce({ db: db2, pref: { ...pref, sources: [pref.sources[0]] }, now: () => 5000, adapters: okOnly })
  assert.equal(r2.status, 'done')
})

test('已 judged 的条目不重新进入候选', async () => {
  const db = dbOf()
  await runOnce({ db, pref, now: () => 5000, adapters: adapters() })
  const [first] = candidates(db, 10)
  db.prepare("UPDATE items SET status='judged' WHERE id=?").run(first.id)
  await runOnce({ db, pref, now: () => 9000, adapters: { rss: fakeAdapter('rss', { ok: { items: [rawOf('ok', { external_id: first.external_id })] }, bad: { items: [] } }) } })
  assert.ok(!candidates(db, 50).some(r => r.id === first.id))
})

test('日志不含家目录，且失败源有记录', async () => {
  const db = dbOf()
  const lines = []
  await runOnce({ db, pref, now: () => 5000, adapters: adapters(), log: e => lines.push(JSON.stringify(e)) })
  const blob = lines.join('\n')
  assert.ok(!/[A-Za-z]:[\\/]Users[\\/]/.test(blob), blob.slice(0, 200))
  assert.ok(!blob.includes(os.homedir()), '日志泄漏了家目录')
  assert.ok(lines.some(l => /"event":"source_failed"/.test(l)))
})
```

日志断言只用 `os.homedir()` 比较，**不要把真实用户名写进测试源码**——测试文件会进仓库，等于把真名推到远程。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/runner.test.js`
Expected: FAIL — `Cannot find module '../lib/runner.js'`

- [ ] **Step 4: 写 `lib/jobs.js`**

```js
import { listSources, getCursor, upsertSource } from './store.js'

export function syncSources(db, pref) {
  for (const s of pref.sources ?? []) upsertSource(db, s)
}

export function planJobs({ db, pref, now = Date.now }) {
  const windowEnd = Number(now())
  return listSources(db)
    .filter(s => s.enabled === 1)
    .map(s => {
      const iso = getCursor(db, s.id)
      const ms = iso ? Date.parse(iso) : NaN
      return { source: s, type: s.type, since: Number.isFinite(ms) ? ms : null, windowEnd }
    })
}
```

（`upsertSource` 从 `store.js` 导入；`syncSources` 单独导出便于测试直接调用。）

- [ ] **Step 5: 写 `lib/runner.js`**

```js
import { adapterFor } from './adapters/index.js'
import { runJobs } from './pool.js'
import { normalize } from './normalize.js'
import { putDraft } from './dedup.js'
import { gate } from './prefilter.js'
import { planJobs, syncSources } from './jobs.js'
import { createRun, patchRun, finishRun, setCursor, setSourceResult } from './store.js'

export { planJobs, syncSources }

export async function runOnce({ db, pref, now = Date.now, log = () => {}, fetchImpl, adapters, trigger = 'schedule' }) {
  const at = now()
  const runId = createRun(db, trigger, () => at)
  syncSources(db, pref)
  const jobs = planJobs({ db, pref, now: () => at })
  const emit = (level, event, detail, source_id) => log({ at: now(), level, event, detail, source_id, run_id: runId })
  emit('info', 'run_start', `${jobs.length} 个源`)

  const results = await runJobs(jobs, {
    limit: 4,
    timeoutMs: 20000,
    retries: 1,
    run: async (job) => {
      const adapter = adapters?.[job.type] ?? adapterFor(job.type)
      if (!adapter) { const e = new Error(`未注册的适配器类型 ${job.type}`); e.parse = true; throw e }
      const items = await adapter.fetch(job.source, { since: job.since, fetchImpl, now: () => now() })
      return { items, windowEnd: job.windowEnd }
    }
  })

  const stats = { fetched: 0, inserted: 0, updated: 0, duplicate: 0, archived: 0, candidates: 0, per_source: {} }
  for (const r of results) {
    const id = r.job.source.id
    if (!r.ok) {
      stats.per_source[id] = { ok: false, fetched: 0, error_class: r.error_class }
      setSourceResult(db, id, { ok: false, error_class: r.error_class, error: String(r.error?.message ?? r.error).slice(0, 200), at: now() })
      emit('warn', 'source_failed', `${r.error_class}: ${String(r.error?.message ?? '').slice(0, 120)}`, id)
      continue
    }
    const items = r.value.items ?? []
    let inserted = 0, updated = 0, duplicate = 0, archived = 0
    for (const raw of items) {
      const source = r.job.source
      const draft = normalize({ ...raw, source_id: source.id, source_type: source.type, fetched_at: raw.fetched_at ?? at }, source, pref, now)
      const rejected = Number(draft.rejected_by_theme ?? 0)
      const { rejected_by_theme: _r, stale: _s, ...row } = draft
      const put = putDraft(db, row, now)
      if (put.action === 'insert') inserted++
      else if (put.action === 'update') updated++
      else if (put.action === 'duplicate') duplicate++
      if (put.action === 'skip_seen') continue
      const g = gate(row, pref, now)
      if (!g.pass) {
        if (put.action !== 'duplicate') {
          db.prepare("UPDATE items SET status='archived', archived_reason=? WHERE id=?").run(`${g.reason}:${g.detail ?? ''}`, put.id)
          archived++
        }
        continue
      }
      if (rejected) archived++
      stats.candidates++
    }
    stats.fetched += items.length
    stats.inserted += inserted; stats.updated += updated; stats.duplicate += duplicate; stats.archived += archived
    setCursor(db, id, new Date(r.value.windowEnd).toISOString())
    setSourceResult(db, id, { ok: true, at: now() })
    stats.per_source[id] = { ok: true, fetched: items.length, inserted, updated, duplicate, archived }
    emit('info', 'source_ok', `${items.length} 条 → 候选 ${stats.per_source[id].inserted}`, id)
  }

  const okCount = Object.values(stats.per_source).filter(s => s.ok).length
  const status = okCount === 0 ? 'failed' : okCount < results.length ? 'partial' : 'done'
  patchRun(db, runId, { candidates: stats.candidates, per_source: stats.per_source })
  finishRun(db, runId, { status, candidates: stats.candidates, per_source: stats.per_source }, () => now())
  emit(status === 'done' ? 'info' : 'warn', 'run_end', `${status} 抓 ${stats.fetched} / 候选 ${stats.candidates}`, null)
  return { runId, status, stats }
}
```

`runOnce` 不抓异常往外抛：单个源的失败已在 `runJobs` 里变成结果。**唯一允许往外抛的是偏好本身不合法**，那由调用方（scheduler / 路由）拦下并记 `runs.error`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/runner.test.js`
Expected: PASS 8 tests（含两条已按上文修正的断言）

- [ ] **Step 7: 提交**

```bash
git add lib/jobs.js lib/runner.js test/runner.test.js test/helpers/fake-adapter.js
git commit -m "feat: runOnce 编排，失败源保持游标以补齐缺口"
```

---

## Task 9: 时段窗、单实例锁与手动触发

**Files:**
- Create: `lib/scheduler.js`
- Test: `test/scheduler.test.js`

**Interfaces:**
- Consumes: `runOnce`（Task 8）、`loadPreference`（Task 2）、`openStore`（Task 1）、`lastRun`（Task 6）
- Produces:
  - `withinWindow(windows, dateLike) → boolean`（支持跨零点，如 `18:00-09:00`）
  - `dueReason({ db, pref, now, running, minGapMs }) → null | 'window' | 'running' | 'too-soon'`，`null` 表示可以跑
  - `createScheduler({ db, getPref, runOnce, now, log, tickMin = 5, lockFile }) → { start, stop, triggerNow }`

- [ ] **Step 1: 写失败的测试 `test/scheduler.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore, migrate, createRun, finishRun } from '../lib/store.js'
import { withinWindow, dueReason, createScheduler } from '../lib/scheduler.js'

const at = (s) => new Date(`2026-10-23T${s}:00+08:00`).getTime()
const pref = { schedule: { windows: ['07:00-09:00', '12:30-13:30'], max_per_run: 10 } }

test('时段窗：区间内真、区间外假、边界含起点不含终点', () => {
  assert.equal(withinWindow(['07:00-09:00'], at('07:00')), true)
  assert.equal(withinWindow(['07:00-09:00'], at('08:59')), true)
  assert.equal(withinWindow(['07:00-09:00'], at('09:00')), false)
  assert.equal(withinWindow(['07:00-09:00', '12:30-13:30'], at('12:45')), true)
  assert.equal(withinWindow([], at('12:45')), true)               // 空窗＝不限时段
})

test('跨零点的窗（18:00-09:00）早晚都算，下午三点不算', () => {
  assert.equal(withinWindow(['18:00-09:00'], at('21:00')), true)
  assert.equal(withinWindow(['18:00-09:00'], at('03:00')), true)
  assert.equal(withinWindow(['18:00-09:00'], at('15:00')), false)
})

test('不在窗内报 window；正在跑报 running；离上次太近报 too-soon', () => {
  const { db } = openStore(':memory:'); migrate(db)
  assert.equal(dueReason({ db, pref, now: () => at('20:00'), running: false }), 'window')
  assert.equal(dueReason({ db, pref, now: () => at('08:00'), running: true }), 'running')
  const id = createRun(db, 'schedule', () => at('08:00'))
  finishRun(db, id, { status: 'done' }, () => at('08:01'))
  assert.equal(dueReason({ db, pref, now: () => at('08:05'), running: false, minGapMs: 600000 }), 'too-soon')
  assert.equal(dueReason({ db, pref, now: () => at('08:20'), running: false, minGapMs: 600000 }), null)
  db.close()
})

test('triggerNow 无视时段窗，但仍受单实例锁约束', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-sched-'))
  let runs = 0
  const slow = async () => { runs++; await new Promise(r => setTimeout(r, 30)); return { runId: 1, status: 'done', stats: {} } }
  const { db } = openStore(':memory:'); migrate(db)
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }), runOnce: slow,
    now: () => at('20:00'), log: () => {}, lockFile: path.join(dir, 'run.lock')
  })
  const p = await Promise.all([s.triggerNow(), s.triggerNow()])
  assert.deepEqual(p.map(r => r.skipped), [false, true])
  assert.equal(runs, 1)
  db.close()
})

test('自动 tick 只在窗内跑，start 只登记不立刻抓', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-sched-'))
  let n = 0
  const { db } = openStore(':memory:'); migrate(db)
  const s = createScheduler({
    db, getPref: () => ({ pref, errors: [] }), runOnce: async () => { n++; return { runId: n, status: 'done', stats: {} } },
    now: () => at('20:00'), log: () => {}, tickMin: 1, lockFile: path.join(dir, 'run.lock'),
    setInterval: (fn, ms) => ({ fn, ms }), clearInterval: () => {}
  })
  assert.deepEqual(s.tick(), { skipped: true, why: 'window' })   // 20:00 不在窗内
  assert.equal(n, 0)
  const handle = s.start()
  assert.equal(handle.ms, 60000)                                 // tickMin=1
  s.stop(handle)
  db.close()
})

test('锁文件写入 pid，异常退出后的陈旧锁不影响手动触发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-sched-'))
  const lockFile = path.join(dir, 'run.lock')
  const { db } = openStore(':memory:'); migrate(db)
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, since: Date.now() - 900000 }))
  let n = 0
  const s = createScheduler({ db, getPref: () => ({ pref, errors: [] }), runOnce: async () => { n++; return { runId: 1, status: 'done', stats: {} } }, now: () => at('08:00'), log: () => {}, lockFile })
  const r = await s.triggerNow()
  assert.equal(r.skipped, false)
  assert.equal(n, 1)
  assert.equal(fs.existsSync(lockFile), false)      // 跑完即释放
  db.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/scheduler.test.js`
Expected: FAIL — `Cannot find module '../lib/scheduler.js'`

- [ ] **Step 3: 写 `lib/scheduler.js`**

```js
import fs from 'node:fs'
import path from 'node:path'
import { lastRun } from './store.js'
import { ensureHome } from './paths.js'

const DAY_MIN = 1440

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function withinWindow(windows, dateLike) {
  if (!windows?.length) return true
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  const cur = d.getHours() * 60 + d.getMinutes()
  return windows.some(w => {
    const [a, b] = String(w).split('-')
    if (!a || !b) return false
    const s = toMin(a), e = toMin(b)
    return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)     // 跨零点
  })
}

export function dueReason({ db, pref, now = Date.now, running, minGapMs = 120000 }) {
  const at = Number(now())
  if (!withinWindow(pref?.schedule?.windows ?? [], new Date(at))) return 'window'
  if (running) return 'running'
  const prev = lastRun(db)
  if (prev?.started_at && at - Number(prev.started_at) < minGapMs) return 'too-soon'
  return null
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function alive(pid) {
  if (!Number.isInteger(pid)) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function createScheduler({ db, getPref, runOnce, now = Date.now, log = () => {}, tickMin = 5, lockFile, setInterval: setIntervalImpl = setInterval, clearInterval: clearIntervalImpl = clearInterval }) {
  const lock = lockFile ?? path.join(ensureHome(), 'run.lock')
  let busy = false

  function acquire() {
    const cur = readLock(lock)
    if (cur && alive(cur.pid)) return false
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: now() }), 'utf8')
    return true
  }

  async function fire(trigger) {
    if (busy) { log({ at: now(), level: 'info', event: 'skipped_running', detail: trigger }); return { skipped: true, why: 'running' } }
    busy = true
    if (!acquire()) { busy = false; log({ at: now(), level: 'warn', event: 'skipped_lock', detail: trigger }); return { skipped: true, why: 'lock' } }
    let out
    try {
      const { pref, errors } = getPref()
      if (errors?.length) {
        log({ at: now(), level: 'error', event: 'preference_invalid', detail: errors.join(' | ') })
        return { skipped: true, why: 'preference', errors }
      }
      out = await runOnce({ db, pref, now, log, trigger })
      return { skipped: false, ...out }
    } catch (e) {
      log({ at: now(), level: 'error', event: 'run_crashed', detail: String(e?.message ?? e).slice(0, 200) })
      return { skipped: true, why: 'crash' }
    } finally {
      busy = false
      try { fs.rmSync(lock, { force: true }) } catch { /* 锁残留由 alive() 判定清理，不影响下次 */ }
    }
  }

  return {
    tick() {
      const { pref } = getPref()
      const why = dueReason({ db, pref, now, running: busy })
      if (why) {
        if (why !== 'window') log({ at: now(), level: 'info', event: `not_due_${why}`, detail: 'tick' })
        return { skipped: true, why }
      }
      fire('schedule')
      return { skipped: false }
    },
    start() {
      const ms = Math.max(1, tickMin) * 60000
      const handle = setIntervalImpl(() => this.tick(), ms)
      return { handle, ms }
    },
    stop(handle) { if (handle?.handle) clearIntervalImpl(handle.handle) },
    triggerNow: () => fire('manual')
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/scheduler.test.js`
Expected: PASS 6 tests

- [ ] **Step 5: 提交**

```bash
git add lib/scheduler.js test/scheduler.test.js
git commit -m "feat: 时段窗、跨零点窗口与带文件锁的单实例调度"
```

---

## Task 10: 宿主半接线（服务、路由、脱敏日志、启动装配）

**Files:**
- Create: `lib/diag.js`
- Create: `index.js`
- Create: `test/diag.test.js`
- Test: `test/host-surface.test.js`

**Interfaces:**
- Consumes: Task 8/9 的 `runOnce` / `createScheduler` / `loadPreference` / `openStore` / `counts` / `listItems` / `lastRun`
- Produces:
  - `makeLogger({ dir, now, writeFile }) → (entry) => void`、`redact(str) → str`
  - 宿主服务名 `baleen`，暴露 `{ read, stats, runNow, prefs }`
  - HTTP：`GET /api/dsh-baleen/state`、`POST /api/dsh-baleen/run`、`GET /api/dsh-baleen/items`
  - `baleen.state() → { last_run, counts, next_due, sources: [{id, ok, error_class}], preference_errors }`

- [ ] **Step 1: 抄准宿主的注册写法（这一步不写代码，只记录事实）**

Run + 读：
```bash
sed -n '160,180p;250,300p;700,770p' /d/dsh-study-desk/index.js
grep -n "webServer\|provide(\|apply(\|ctx.on(" /d/dsh-study-desk/index.js | head -20
```
把看到的**注册调用原样**抄进 `docs/verification.md` 新增一节「宿主写法事实」：`inject` 数组怎么写、路由是 `ctx.webServer.xxx(...)` 还是别的、`apply(ctx, config)` 的形参、服务用 `ctx.provide` 还是别的。**Task 10 后面的实现以这段事实为准**，与本计划示例冲突时改本计划的示例，不改宿主。

- [ ] **Step 2: 写失败的测试 `test/diag.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { redact, makeLogger } from '../lib/diag.js'

test('脱敏掉家目录、Windows 盘符路径、token/cookie 值', () => {
  const home = os.homedir()
  assert.match(redact(`读不到 ${home}/.dsh/baleen/x`), /<HOME>/, '家目录未脱敏')
  assert.match(redact('D:\\SomeUser\\secrets'), /<PATH>/)
  const r = redact('authorization: Bearer abc.def; Cookie: sid=1')
  assert.ok(!/abc\.def/.test(r), r)
  assert.ok(!/sid=1/.test(r), r)
  assert.match(r, /<REDACTED>/)
})

test('日志写 jsonl，单行不超 400 字符，且不抛异常', () => {
  const chunks = []
  const log = makeLogger({ dir: '/tmp/x', now: () => 1000, writeFile: (f, s) => chunks.push(s) })
  log({ level: 'info', event: 'run_start', detail: 'y'.repeat(2000) })
  const line = chunks[0].trim()
  assert.ok(line.length <= 400, String(line.length))
  assert.equal(JSON.parse(line).event, 'run_start')
  assert.equal(JSON.parse(line).at, 1000)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/diag.test.js`
Expected: FAIL — `Cannot find module '../lib/diag.js'`

- [ ] **Step 4: 写 `lib/diag.js`**

```js
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SECRET_KEY = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key|credential)\s*[:=]\s*[^,;]}"'\s]+/gi
const WIN_PATH = /[A-Za-z]:[\\/](?:[^\s"'<>|\\]|\\ )+/g
const HOME = os.homedir().replace(/[\\]/g, '\\\\')
const HOME_RE = new RegExp(`(?:${HOME}|~\\/\\.dsh)(?:[\\\\/][^\\s"'<>|]*)?`, 'g')

export function redact(str) {
  let out = String(str ?? '')
  out = out.replace(HOME_RE, '<HOME>')
  out = out.replace(WIN_PATH, '<PATH>')
  out = out.replace(SECRET_KEY, '$1: <REDACTED>')
  return out
}

export function makeLogger({ dir, now = Date.now, writeFile = (f, s) => fs.appendFileSync(f, s, 'utf8'), level = 'info' } = {}) {
  const file = dir ? path.join(dir, 'logs', 'diagnostics.jsonl') : null
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true })
  return (entry) => {
    const e = { at: entry.at ?? now(), level: entry.level ?? level, event: entry.event ?? 'log', detail: redact(String(entry.detail ?? '')).slice(0, 220), source_id: entry.source_id ?? null, run_id: entry.run_id ?? null }
    const line = JSON.stringify(e) + '\n'
    if (line.length > 400) return
    if (file) { try { writeFile(file, line) } catch { /* 日志失败绝不影响抓取 */ } }
  }
}
```

- [ ] **Step 5: 写 `index.js`（宿主半入口，路由注册按 Step 1 记录的事实调整）**

```js
import fs from 'node:fs'
import path from 'node:path'
import { openStore, migrate, counts, listItems, listSources, lastRun, getCursor } from './lib/store.js'
import { loadPreference } from './lib/preference.js'
import { runOnce } from './lib/runner.js'
import { createScheduler } from './lib/scheduler.js'
import { makeLogger } from './lib/diag.js'
import { ensureHome } from './lib/paths.js'

export const name = 'dsh-baleen'
export const inject = ['webServer']

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx, config = {}) {
  const dir = ensureHome()
  const log = makeLogger({ dir })
  const { db } = openStore(path.join(dir, 'baleen.sqlite'))
  migrate(db)

  const getPref = () => loadPreference(dir)
  const scheduler = createScheduler({ db, getPref, runOnce, log })

  function state() {
    const { pref, errors } = getPref()
    const prev = lastRun(db)
    return {
      home: '<HOME>',
      counts: counts(db),
      last_run: prev ? { id: prev.id, status: prev.status, at: prev.started_at, finished_at: prev.finished_at, candidates: prev.candidates } : null,
      sources: listSources(db).map(s => ({ id: s.id, type: s.type, enabled: !!s.enabled, ok: !s.last_error_class, error_class: s.last_error_class, cursor: getCursor(db, s.id) })),
      preference_errors: errors,
      schedule: pref.schedule
    }
  }

  const baleen = {
    state,
    list: (opts) => listItems(db, opts),
    runNow: async () => runOnce({ db, pref: getPref().pref, log, trigger: 'manual' }),
    triggerNow: () => scheduler.triggerNow(),
    start: () => scheduler.start(),
    stop: (h) => scheduler.stop(h)
  }

  // ↓↓ 这一段的具体 API 名以 Step 1 抄下来的宿主写法为准；逻辑不变。
  ctx.provide('baleen', baleen)
  ctx.webServer?.use?.('/api/dsh-baleen', async (req, res) => {
    const url = new URL(req.url, 'http://local')
    try {
      if (url.pathname === '/state' && req.method === 'GET') return json(res, 200, { ok: true, ...state() })
      if (url.pathname === '/items' && req.method === 'GET') {
        return json(res, 200, { ok: true, items: baleen.list({
          status: url.searchParams.get('status'), kind: url.searchParams.get('kind'),
          tier: url.searchParams.get('tier'), limit: Number(url.searchParams.get('limit') ?? 100),
          offset: Number(url.searchParams.get('offset') ?? 0)
        }) })
      }
      if (url.pathname === '/run' && req.method === 'POST') {
        const r = await baleen.triggerNow()
        return json(res, 200, { ok: !r.skipped, ...r })
      }
      return json(res, 404, { ok: false, error: 'no such route' })
    } catch (e) {
      log({ level: 'error', event: 'route_failed', detail: e?.message })
      return json(res, 500, { ok: false, error: 'internal' })
    }
  })

  ctx.on?.('ready', () => {
    log({ level: 'info', event: 'plugin_ready', detail: '宿主半装配完成，调度已登记' })
    scheduler.start()
  })

  return baleen
}
```

`ctx.webServer?.use?.()` 用可选链是刻意的：本机 profile 上若 `webServer` 服务名与 study-desk 抄来的不一致，插件会**安静地不挂路由**而不是炸掉启动——执行时必须按 Step 1 的事实改成真实调用，并用 `test/host-surface.test.js` 断言它真的挂上了。

- [ ] **Step 6: 写 `test/host-surface.test.js`（不启动 DSH，只验导出形状与纯逻辑）**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import index.js 之前把家目录指到临时区，否则 apply() 会往真实的 ~/.dsh/baleen 写库
process.env.BALEEN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baleen-host-'))
const host = await import('../index.js')

test('宿主半导出形状固定', () => {
  assert.equal(host.name, 'dsh-baleen')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('apply 在没有 webServer 的假 ctx 下不抛，并返回可读 state', () => {
  const calls = []
  const ctx = { provide: (n, v) => calls.push(['provide', n, Object.keys(v).sort().join(',')]), on: (e) => calls.push(['on', e]) }
  const baleen = host.apply(ctx, {})
  const s = baleen.state()
  assert.equal(calls[0][1], 'baleen')
  assert.ok(Array.isArray(s.sources))
  assert.equal(s.home, '<HOME>')
  assert.ok(s.last_run === null || typeof s.last_run.status === 'string')
})

test('apply 把库和日志都落在 BALEEN_HOME 里，不碰真实家目录', () => {
  assert.ok(fs.existsSync(path.join(process.env.BALEEN_HOME, 'baleen.sqlite')), '库没落在指定家目录')
  assert.ok(fs.existsSync(path.join(process.env.BALEEN_HOME, 'out')), 'ensureHome 没建 out/')
})
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test "test/*.test.js"`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add index.js lib/diag.js test/diag.test.js test/host-surface.test.js docs/verification.md
git commit -m "feat: 宿主半接线（服务、只读路由、脱敏日志、调度启动）"
```

---

## Task 11: 真机装载、真抓一轮与 V6 记录

**Files:**
- Modify: `docs/verification.md`
- Create: `README.md`
- Create: `preference.example.yaml`

**Interfaces:**
- Consumes: Task 10 的 `index.js`
- Produces: V4/V6 的实测结论、可交给别人照做的 README、一份能直接复制用的偏好样本

⚠️ 本任务会**动 DSH 的 profile 目录并重启应用**。开始前必须：向用户确认可以重启 DSH；提醒她**一次只切换一个插件**（快速连续切换曾把 `cordis.patch.yml` 从 3595 B 写成 751 B）；**绝对不要点启动失败弹窗里的"禁用第三方插件、备份 profile patch 并重启"**（那个按钮会重新序列化并再次清掉文件）。

- [ ] **Step 1: 备份将要改动的两个文件**

```bash
P=/d/DSH/.dsh/profiles/desktop
cp "$P/cordis.patch.yml" "$P/cordis.patch.yml.bak-before-baleen-$(date +%s)" 
cp "$P/package.json" "$P/package.json.bak-before-baleen-$(date +%s)"
python -c "import yaml,sys;d=yaml.safe_load(open(sys.argv[1],encoding='utf-8'));print('entries:',len(d))" "$P/cordis.patch.yml"
```
记录条目数基线（前后要能对上，只多我们那一条）。

- [ ] **Step 2: 用 link 方式装进 desktop profile**

```bash
cd /d/DSH/.dsh/profiles/desktop
D:/nodejs/node.exe "D:/Program Files/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
```
（`link:` 目录登记方式与 study-desk 一致，见 study-desk 的 `install.mjs` / profile `package.json` 的 `dependencies` + `dsh.profile.bundles`。**依赖 `yaml` 若被 24h `minimumReleaseAge` 拒**，按既有做法把它加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，版本号写精确。）

装完**先不重启**，用免费的装配检查确认 bundle 进得去（Task 0 实测过：`--dump-config` 只打印不启动）：

```bash
D="/d/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
"$D" --profile desktop --dump-config 2>&1 | grep -n -A3 "dsh-baleen"
```
Expected: 能看到 `name: dsh-baleen`（或 `file://...` 形态）那一条。看不到就是登记没生效，先修装配再重启，别用重启去试错。

- [ ] **Step 3: 重启 DSH（由用户操作或明确批准后执行）**

用界面退出再启动，**不要**用 `ELECTRON_RUN_AS_NODE=1` 拉 GUI 进程。启动后：

```bash
ls -t "/c/Users/<USER>/AppData/Roaming/@deepseek-ai/dsh-desktop/logs/" 2>/dev/null | head -5
```
Expected: **没有新增** `crash-*-web-boot.log`。有新增就读它，里面 `1 entry did not activate / dsh-baleen` 就是宿主半或客户端半装配失败；按 study-desk 那次的教训，先看 `inject` 声明缺什么。成功的启动会**清掉**旧的 crash log，所以"文件数变少"是正常的，比文件名不比数量。

- [ ] **Step 4: 写 `preference.example.yaml`**（以 Task 2 的 `DEFAULTS` 为底，加两组真实主题和三个真实 feed，字段名与校验规则完全一致）

- [ ] **Step 5: 手动跑一轮真抓取（只开 rss，先不碰平台）**

桌面版默认不监听 HTTP 端口（`webServer` 路由能否从外部 curl 到，属于本次要确认的事实之一），所以**主路径是不经 HTTP 直接调**：

```bash
cd /d/dsh-baleen
BALEEN_HOME=/d/tmp/baleen-live node --input-type=module -e "
import fs from 'node:fs'
fs.writeFileSync('/d/tmp/baleen-live/preference.yaml', fs.readFileSync('preference.example.yaml','utf8'))
const ctx = { provide(){}, on(){} }
const { apply } = await import('file:///D:/dsh-baleen/index.js')
const b = apply(ctx, {})
const r = await b.runNow()
console.log(JSON.stringify({ status: r.status, stats: r.stats }))
console.log(JSON.stringify(b.state().sources))
"
```
Expected: `status` 为 `done` 或 `partial`；`sources[].cursor` 对成功源有 ISO 时间、失败源为 null；`b.state().counts` 的 `new` 大于 0。

再单独确认 HTTP 路由：查 `~/.dsh/web-dsh.log` 里最近一次 web 启动的端口与 token（`dsh --profile web --no-open --port 8788` 才会打出来），然后
`curl -s http://127.0.0.1:8788/api/dsh-baleen/state`。**curl 不通就记进 `docs/verification.md` 当作 V4 的一部分**（说明桌面版的 webServer 挂载点与 web profile 不同），不要在路由上继续耗时间——M1 的判据是"能跑一轮并能读回状态"，走 `runNow()` 已满足。

- [ ] **Step 6: 把 V6（RSS 对 Medium/Substack 的实际覆盖率）写进文档**

先用这条查询把每个源的 `body_state` 分布取出来（数字来自实测，不要手填估计值）：

```bash
node --input-type=module -e "
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync('D:/tmp/baleen-live/baleen.sqlite')
for (const r of db.prepare('SELECT source_id, body_state, COUNT(*) n FROM items GROUP BY source_id, body_state ORDER BY source_id').all())
  console.log(r.source_id, r.body_state, r.n)
"
```

`docs/verification.md` 新增一节，每个源一行，列就是上面查询的输出：

```markdown
## V6 feed 覆盖
| 源 | 抓回条数 | full | summary_only | missing | 备注（付费墙/编码/字段缺失） |
|---|---|---|---|---|---|
- 结论：文章区默认形态是全文还是摘要；`README` 与面板徽章文案是否要跟着改
- 未跑通的源单独列出，写"不可达"并附 `curl -sSI` 的返回码
```

选 feed 的方式：先用 `curl -sSI` 逐个探活（`https://blog.cloudflare.com/rss/` 这类公开博客可作候选），**用用户自己在读的真实 feed 优先**，探不通的记为"不可达"而不是猜内容。

- [ ] **Step 7: 写 `README.md`**，必须包含：一句话是什么、v1 已做/未做清单（未做：判断轮、面板、平台 MCP、设置页）、安装（link 方式与 `dsh plugin add` 两种）、装完必须重启、一次只切一个插件、凭据与库落在哪、如何只跑 RSS、测试命令、以及"名字撞车"提示（NLP 圈已有同名 RSS 摄取项目，我们带 `dsh-` 前缀）。

- [ ] **Step 8: 文档同步检查（改了实现就要当轮扫文档）**

检查这三处是否与新事实一致，不一致就地改：`AGENTS.md` 的宿主写法条目（Task 10 Step 1 抄到的真实 API 名）、`README.md` 的未做清单、`docs/verification.md` 的 V1/V2/V4/V6。

- [ ] **Step 9: 全量测试 + 提交**

Run: `node --test "test/*.test.js"`
Expected: 全绿

```bash
git add README.md preference.example.yaml docs/verification.md AGENTS.md
git commit -m "docs: 真机装载记录、feed 覆盖率实测与可复制偏好样本"
```

- [ ] **Step 10: 打 tag 作为 M1 终点**

```bash
git tag m1-ingest -m "M1：定时摄取入库跑通（RSS），失败不推进游标"
```

---

## 本计划不做什么（避免执行者顺手越界）

- 不写 `client.js`、不注册任何 slot（M2 的面板计划做）。
- 不调模型、不起 headless 会话、不解析报告（M3）。
- 不 vendor `bilibili-mcp`、不接小红书（M4）。
- 不做设置页四页签（M5）。
- 不 push 到 GitHub、不建 `slow-stack/dsh-baleen` 远程、不 `npm publish`——任何对外动作先出草稿等用户批准。
- `preference.yaml` 里本计划**不消费**的字段，执行时不要顺手加实现，也不要在 README 里声称已生效：
  - `schedule.off_peak_only`：本计划里峰谷完全由 `schedule.windows` 体现，没有单独逻辑读它；M3 起判断轮才把它当会话启动条件。
  - `follow` 下的 `bilibili` / `xiaohongshu` 账号项：M4 才有对应适配器；本计划只用 `follow.feeds`（URL 匹配）。
  - `charter`：M3 的判断轮才注入。
  （`limits.min_duration_sec`、`limits.max_age_days`、`limits.skip_kinds`、`redlines`、`themes`、`tuning` 都在本计划里被真实消费，有测试覆盖。）

## 交付判据（整个计划完成的定义）

1. `npm test` 全绿，且 `test/runner.test.js` 里"坏源恢复后补齐缺口"那条通过——它是"失败不推进游标"这条不变量的直接证据。
2. 本机 desktop profile 装载后 DSH 正常启动（无新 crash log）。
3. 手动一轮真实 RSS 抓取入库，`state` 里能看到每源成败与游标；`counts()` 的 `new` 数与候选一致。
4. `docs/verification.md` 里 V1/V2/V4/V6 四条有实测结论（含"未测"的写明为什么），V3/V5 明确留给后续计划。

## 实现偏差记录（Task 1–9 落地时，按实际代码为准）

计划写给执行者读，但代码写出来后有八处和计划示例不一致。都是**实现更好、计划更粗**的情形，逐条留痕，免得下一个人以为文档就是事实。

1. **`package.json` 必须第一个落**。计划把它的步骤排在测试之后，而测试文件用 ESM `import`——没有 `type: module` 时 `node --test` 直接报 `Cannot use import statement outside a module`。已加 Step 0。
2. **`node --test test/` 在 Windows 上会把目录当模块解析**，报 `Cannot find module ...\\test`。测试脚本与全部文档统一改成 `node --test "test/*.test.js"`（`npm test` 已是该形式）。
3. **DDL 多了 `title_norm` 列与索引**。二级去重要按"去掉空白和标点的标题"比对，SQL 里做不了正则清洗，所以在写库时算好存下来；`normalize` 不产这个列，由 `putDraft` 负责。
4. **URL 归一化挪到写库边界**。原计划只在适配器/解析器里清 `utm`，实测发现只要任何一个适配器忘了清，URL 级去重就**静默失效**（无报错）。现在 `putDraft` 统一 `cleanUrl`，并有测试盯着"库里存的 url 一定没有跟踪参数"。
5. **`normalize` 的产出正好等于 items 的 20 个插入列**，不多不少。计划里它还返回 `rejected_by_theme` / `stale` 两个私货字段——那会让"Draft 能不能直接插库"变成一个需要记住的口头约定。现在有一条测试用列名清单做 `deepEqual` 断言，把约定变成机器盯的不变量；`rejected` 这类判断信息放进 `match_json`。
6. **新增 `prefilter.summarizeGaps` 与固定 `REASONS`**。spec §7 要求"读不到的东西必须可见"，但计划里没有任何数据结构承载它；现在每轮的丢弃计数进 `runs.per_source_json` 与返回值 `stats.gaps`，汇报区直接消费。
7. **`counts()` 返回四个状态**（`new`/`judged`/`digest`/`archived` + `total`），计划里少 `digest`。`listItems` 的筛选参数与 M2 面板的 facet 对齐。
8. **`validate` 只接受 `type: rss`**，`bili`/`xhs`/`yt` 在 M4 登记进 `KNOWN_TYPES` 之前会被拒。这是刻意的：宁可现在报错，也不要用户填了一个"看起来支持"的源、跑起来才发现没有适配器。
9. **`createScheduler` 暴露 `tick()`**，`start()` 只登记 interval。计划把窗内判断埋在 `start()` 里，导致"窗外不该抓取"这条无法直接测；分开之后它有自己的断言，跨零点窗也有。
10. **测试替身不模拟 `since` 过滤**（那是 rss 适配器的职责，另有测试盯），于是 runner 的测试如实断言"第二轮回来的旧条目走 update、不变成第二行"——比假装过滤更诚实，也顺便验证了第二道防线。
11. **Task 10 Step 1 抄到的宿主写法与原示例不同**，以抄到的为准：路由是 `webServer.register({ kind:'prefix', path, handler })` 且必须包在 `ctx.effect(fn, label)` 里；服务注册用 `ctx.provide`（`ctx.set` 对未 provide 的服务会抛）；**桌面端 UI 跑在自定义协议上，只有 `/api/*` 会被转发到宿主**，所以路由前缀固定 `/api/dsh-baleen`。`apply()` 里取服务用 `ctx.get('webServer') ?? ctx.webServer`，取不到就记一条 `no_webserver` 错误日志而不是抛——禁用插件时不该连带炸宿主。
12. **两处实现 bug 由测试当场抓住并修掉**（都不是改断言）：
    - `runOnce` 在**没有任何 job** 时把状态记成 `failed`（因为 `okCount === 0`），新装好的插件会在面板上亮假红点。改为 `results.length === 0 → done`，并加了专门的测试。
    - 路由对 `?limit=abc` 这类坏参数会走到 500。改为 `num()` 消毒：非法就用默认值，并且 `limit` 上限 500、`offset` 不为负。
13. `createScheduler` 的 `setInterval/clearInterval` 可由 `apply(ctx, config)` 注入。测试必须注入——否则 5 分钟的真 interval 会把 `node --test` 的进程吊住不退出。`ctx.effect` 返回 dispose 函数来停定时器，禁用插件后不会留下偷偷抓取的计时器。

执行中发现的两个测试自己的错（都已改测试而不是改实现）：`prefilter` 那条把 `total_dropped` 算成 3（正确是 4，带 `keep` 标记的不算丢弃）；fixture 里一个标题被我写成双重转义 `&amp;amp;`，与真实 feed 的形状不符。

## 真实抓取暴露的三个产品级缺陷（Task 11 前半段，全部改了实现）

拿 5 个可达的公开 feed（Cloudflare / Substack·Pragmatic Engineer / Medium·Addy Osmani / 少数派 / HN）跑了一轮真摄取，80 条。真数据立刻打出三个单元测试打不出来的问题：

1. **英文关键词用子串匹配，命中理由是假的。** `UI` 命中 "b**ui**lding"、`agent` 命中 "man**agement**"，于是"What's the ROI of software engineers' spending"被标成"命中 MCP / agent / UI"、得分 2.89。已改为**纯 ASCII 关键词走词边界、中文走子串**（中文没有词边界，只能子串），并有测试专门钉住这两个反例。这条最要命：理由可信是这个产品唯一的硬承诺，假理由比不理由更糟。
2. **来源权重让 `below-score` 形同虚设。** `prefilter_score = 主题分 + follow + 源权重 + tuning`，只要源启用，权重自己就够过闸——第一轮 80 条里 56 条进候选，其中相当多一条主题都没命中。新增 `no-match` 原因与 `require_theme_hit`（默认 true）：没命中任何主题且不是关注 feed 就不进候选。改完同一批数据是 **26 条候选 / 54 条丢弃**，其中 `no-match` 30、`stale` 24；关注源（Cloudflare）仍然 20 条全进——这正确表达"订阅即信任"。
3. **启动时不镜像偏好。** 面板要等第一轮跑完才看得到源列表，"配置了但还没到点"看起来像"没配置"。改为 `apply()` 里就 `syncSources`，并加了测试。

顺带确认的行为（都符合设计）：`body_state` 在真实 feed 上的分布是 Cloudflare/Medium 全文、Substack 17 全文 + 3 仅摘要、少数派与 HN 全部仅摘要——**文章区的默认形态是摘要**，所以面板上"仅摘要"徽章不是异常态而是常态；Medium 那 10 条全部 `stale`（该作者更新慢，feed 里都是三个月前的），这也说明 `max_age_days` 对低频源要能按源单独设，记进 M5 的设置页需求。

`tools/live-ingest.mjs` 留在仓库里：不经 DSH、用假 ctx 直接跑一轮，`BALEEN_HOME` 指到临时目录就能反复试真数据而不动 `~/.dsh/baleen`。

## 她的三个订阅源暴露的第四个缺陷（过期窗一刀切）

清单：Eco-socialism and Nature（Substack）、Messy Writings（Medium 单个作者）、innei 的小站（独立博客）。三个源全部可达，40 条真内容。

| 源 | 存货中位年龄 | 最老 | 14 天内 |
|---|---|---|---|
| eco-socialism | 137 天 | 206 天 | 2 / 20 |
| innei | 54 天 | 80 天 | 1 / 10 |
| messy-writings | 166 天 | 224 天 | 0 / 10 |

按原设计（全局 `max_age_days: 14`）首轮只留下 **3 条候选**，九成二被当"过期"丢掉。用户拍板改为：

1. **首轮（该源无游标）跳过 stale 规则**——低频作者的存货对刚订阅的源就是最有价值的内容；
2. **`sources[].max_age_days` 可按源覆盖**，省略才用全局值（她的三个源分别设 365 / 365 / 180）。

改后实测：首轮 **40 条候选、0 条丢弃**；紧接着第二轮 **抓 0**——这是第一次在真实 feed 上证明游标过滤成立（同一批内容既不重复入库，也不重复进判断预算）。新增 4 条测试（backlog 两态、按源覆盖、sources 表新列、runner 三轮连跑），累计 112。

顺带说明一处我自己加的猜测：`themes` 里的"生态 / 环境 / 气候"是我按她的备考方向补的，**已在报告里明写并请她确认**，不是为了把数字改好看。

## 第五个缺陷：关键词大小写不分，专名抓普通词

同一批真数据里，messy-writings 那篇《it took me 24 years to realize that love》被判成命中 `React`——因为散文里出现了小写动词 "react"。修法是**把大小写变成关键词的语义**：含大写的纯 ASCII 关键词大小写敏感，全小写的不敏感，非 ASCII 仍走子串。改后该源命中数 1 → 0，四个残留命中全部是真的（`生态` ×2、`agent` ×1、`CSS` ×1）。规则已写进 spec §5 与 README，因为这是写给"用户怎么填关键词"的，不只是内部实现。测试 113 个。

## 累计验收

- `npm test`：88 个测试全绿（store 5 / preference 8 / feed 8 / pool 7 / adapters-rss 6 / normalize 8 / dedup 10 / store-queries 8 / prefilter 11 / runner 9）。
- 提交历史：Task 0–9 各一次 commit，`git log --oneline` 可追溯到每条不变量是谁盯着的。

<!-- CONTINUE-HERE -->





