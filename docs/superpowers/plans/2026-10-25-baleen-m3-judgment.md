# M3 判断轮实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每个任务 TDD，全绿才提交。

**Goal:** 让"判断"发生在已有会话里——插件注册五个只读工具加一个锁死三档的写工具，`system-prompt/assemble` 注入当触发机制；汇报视图接上 M1 留下的 digests 表，今天格的"M3 接入后自动提示"兑现。

**Architecture:** 宿主半 `inject` 加 `'tools'`，`defineTool` 从宿主 `@deepseek-ai/dsh-tools` 解析、失败回退本地等价实现（形态抄自已验证的 dsh-study-desk，见其 index.js:130-175/539/727-732）；store 半加 `saveVerdicts`（批量 + SAVEPOINT + 三档枚举锁死），成功后同事务落一条 digest；注入钩子 ≤200 字带开关；汇报视图从诚实空态换真数据。无独立子进程（D11 已定）。

**Spec:** `docs/superpowers/specs/2026-10-23-baleen-design.md` §10（工具面与注入，binding）、§9（config.json 运行态 / preference.yaml 真源）、§4 路线图 M5 边界。M4 的 `baleen.subtitle` 本计划不注册。

**V7 结论（先决评估，随本计划关闭）：** 宿主没有提供可替代的调度服务——参考实现 dsh-study-desk 同样自管 timer 并靠 `ctx.effect` 生命周期回收。自建调度（lib/scheduler.js）维持，V7 在 verification.md 记"已评估，维持现状"。

## Global Constraints

- AGENTS.md 全部红线继续有效。**本计划的红线核心**：`baleen.save_verdicts` 是唯一写工具，只能写本插件自己的 items 表与 digests 表；平台写动词（评论/私信/点赞/关注/发布/收藏到平台）在工具面零出现——用测试 grep 钉住工具清单与 description 全文。
- `collect` / `folder` / `feedback` / `run`（跑一轮）/ 归档 / 移出夹**仍然不注册为工具**（spec §10.1 明文：判断权给模型，改偏好和改反馈的权给用户）。
- 三档词固定 `值得看 / 可以看 / 不值当`，schema 用枚举，越界直接拒。
- `defineTool` 宿主解析失败必须回退本地等价实现并打一行日志（学 study-desk），不许炸启动。
- 注入 ≤200 字；开关默认开，关掉后判断轮的自动触发入口关闭。
- 零新增 npm 依赖；`node --test "test/*.test.js"`；client.js 改了 src/client 要重新生成；提交中文、一个任务一次提交。

## 文件结构

| 文件 | 责任 | 本计划动作 |
|---|---|---|
| `lib/store.js` | saveVerdicts + digest 落库 | 新增 `saveVerdicts(db, verdicts, now)`（含 digest 写入） |
| `lib/tools.js`（新） | defineTool 解析器 + 本地回退 | 新建（抄 study-desk 形态，注明来源） |
| `index.js` | inject 加 tools、注册五工具、注入钩子、state() 加 digests | 修改 |
| `preference.js` | `inject_prompt` 默认值与校验 | 修改（example.yaml 同步） |
| `src/client/views/digest.js` | 汇报视图接真数据 | 修改 |
| `src/client/views/today.js` | 待判提示兑现 | 修改（一行文案 + 断言） |
| `test/store-collections.test.js` 或新建 `test/store-judgment.test.js` | saveVerdicts 测试 | 新建 |
| `test/host-surface.test.js` / `test/tools.test.js`（新） | 工具面红线测试 | 新建 |
| `test/views-digest.test.js`、`test/preview.test.js`、`test/fixtures/preview-data.js` | 汇报视图与预览 | 修改 |
| `docs/verification.md`、`README.md`、M2 计划偏差记录 | 扫尾 | 修改 |

## Task 1: store 层 `saveVerdicts`（判断落库 + digest）

**Interfaces:**
- `saveVerdicts(db, verdicts, now = Date.now) -> {judged: n, tiers: {值得看: x, 可以看: y, 不值当: z}}`
- verdicts 必须非空数组，每项 `{id: 整数, tier: '值得看'|'可以看'|'不值当', why: 非空字符串}`；空数组/缺字段/越界 tier → 抛 `bad_payload` / `bad_tier`；id 不存在 → 抛 `no_item`（整批 SAVEPOINT 回滚，不留半批）
- 写法：`UPDATE items SET status='judged', verdict_tier=?, verdict_why=? WHERE id=?`（列 M1 已留，零迁移）；**已判条目允许覆盖**（改判是正常操作，why 由调用方写清）
- 成功后同 SAVEPOINT 写 digests 一条：`run_id` = `lastRun()?.id ?? null`（这批候选来自最近摄取轮，零迁移）；`headline = 判了 N 条：值得看 x · 可以看 y · 不值当 z`；`stats_json = JSON.stringify({judged, tiers, at})`；`theme_json` 留 null
- 红线：不碰 feedback / tuning / folder_items

**TDD：** 先写失败测试（三档合法写入并可在 listItems(tier) 查回、越界 tier 响亮拒、id 不存在整批回滚、覆盖改判、digest 落一条且 headline 计数正确、空数组拒绝）→ 实现 → 绿。Run: `node --test "test/store-judgment.test.js"`。

## Task 2: 工具面（五个工具 + 红线测试）

**Interfaces:**
- `lib/tools.js` 导出 `resolveDefineTool()`（宿主包优先、resourcesPath 兜底、本地等价实现兜底，行为与 study-desk 逐字同构）
- `index.js`：`export const inject = ['tools', 'webServer']`；`apply()` 里 `const tools = ctx.get('tools') || ctx.tools`，逐个 `ctx.effect(() => tools.register(t), 'baleen: tool <name>')`
- 五个工具（name 精确、description 中文面向模型）：
  - `baleen.query` — 按 status/kind/tier/since/limit 取条目（listItems 封装；默认只给未归档）
  - `baleen.read_item` — 按 id 取单条全文（title/url/author/body_text/body_state/match_json/verdict）
  - `baleen.candidates` — 本轮待判候选（`candidates(db, max_per_run)`；preference 无此键则默认 8，随 Task 3 在 preference.js 落 `limits.max_per_run` 缺省）
  - `baleen.run_status` — 最近一轮状态、各源成败、候选数、注入开关状态
  - `baleen.save_verdicts` — 唯一写工具；parameters 锁死 `verdicts: array of {id:number, tier:enum('值得看','可以看','不值当'), why:string}`；失败要能把 store 抛的短码带回给模型
- `baleen.subtitle` 不注册（M4）

**TDD：** 新建 `test/tools.test.js`：注册清单**恰好 5 个且名字精确**；`save_verdicts` 的 tier 参数是三档 enum；全部工具 description 与参数拼接后 grep 不到平台写动词（评论/私信/点赞/关注/发布/收藏）；`baleen.collect` 等不存在；defineTool 回退路径能本地构造出同形工具（不 import 宿主包也能过）。红线测试在任何后续改动中红了就是事故。

## Task 3: system-prompt 注入（触发机制）

**Interfaces:**
- `ctx.on('system-prompt/assemble', async (assembly, _context, next) => { assembly.sections?.push?.(...) ?? assembly })`——以 study-desk 同款钩子形参为准，实现前先读它的 732-745 行照抄组装方式
- 文本 ≤200 字：`Baleen：待判 N 条（Top：<title 截断>；…）。上轮源：<ok 摘要或失败源 id 列表>。可用工具 baleen.candidates / read_item / save_verdicts。`候选 0 且无失败源时**完全不注入**（不给会话添噪音）
- 开关：`preference.yaml` 新键 `inject_prompt`（默认 true，DEFAULTS + 校验 + example.yaml 同步）；关 = 跳过钩子逻辑

**TDD：** 注入内容含候选数与工具名、长度 ≤200、候选 0 时不注入、开关关闭时不注入（四面）。

## Task 4: 汇报视图接真数据 + today 提示兑现

- `index.js` state() 在 `digest_count` 旁加 `digests: 最近 5 条 {id, headline, created_at, stats}`
- `digest.js`：有 digests → 列表渲染（headline + 相对时间 + tiers 计数）；没有 → 空态文案从"判断轮（M3）尚未接入"改为"判断轮已接入，但还没有跑过判断——对会话说一句「把今天的候选判一下」"（诚实且指向可用路径）
- `today.js`：待判 >0 的提示改为同一句人话（兑现 :74 的承诺）；待判 0 不变
- 预览门：`preview-data.js` 的 state 夹具加 digests 两条；`preview-digest.html` 断言列表渲染（preview.test.js 追加）；today 页断言新提示文案
- client.js 重新生成

## Task 5: 真机验收 + 文档扫尾

- 真机（需要用户在场配合一次）：配置一个真实源跑一轮 → 在 DSH 会话里说「把今天的候选判一下」→ 观察模型走 candidates → read_item → save_verdicts，面板待判数下降、汇报区出 digest。结果写进 verification.md（含 V7 结论与"未验项"如实清单）
- README 状态行与测试数照实；M2 计划偏差记录追加"M3 让 M2 的待判提示与汇报空态文案兑现"交叉引用；AGENTS.md 硬约束如需补充工具面红线（"工具面恰好五个、save_verdicts 唯一写"）则追加第 12 条
- 红线自查：`grep -rn "评论\|私信\|点赞\|关注\|发布" index.js lib/tools.js` 工具面零命中

## 本计划不做

- `baleen.subtitle`（M4）；B 站/小红书适配器（M4）；设置页（M5）
- 判断结果的 UI 编辑（改判走会话再说一遍，不做人肉表单）
- 每日配额的执行逻辑（run_status 里先如实报"未实现"；配额属 M5 偏好页联动）
- 任何平台写操作的工具化（永远）

## 已知取舍

- **digests.run_id 存最近摄取轮** 而不是放宽 NOT NULL——零迁移，语义是"这批候选来自哪轮"
- **改判即覆盖**——verdict_why 由模型写清改判理由；不给旧判留历史（真要历史可从 diagnostics 日志找）
- **注入是触发机制不是提示**——没有独立进程，全靠这段字让会话知道有候选；关掉开关 = 关掉自动判断入口，面板汇报区要写明
- **工具面用 spec 的六个名字、M3 落五个**——不合并成 study-desk 式单工具多 action（spec §10.1 是 binding authority）

## 自检

Spec 覆盖：§10.1 五工具（subtitle 留 M4）↔ Task 2；save_verdicts schema 锁死 ↔ Task 1/2；§10.2 注入 ≤200 字/开关/触发机制 ↔ Task 3；汇报区真数据 ↔ Task 4；红线（平台写零注册、不注册面板动作）↔ Task 2 测试 + Task 5 自查。无遗漏。

类型一致性：`saveVerdicts` 返回 `{judged, tiers}` 与 digest headline 计数同源；`candidates(db, max_per_run)` 在 store/工具/注入三处同名；`inject_prompt` 键名在 preference/注入/状态四处一致。

## 执行方式

Subagent-driven：每任务全新 implementer + 独立评审，全绿才提交；计划内部冲突先裁定再派发。分支持续用 main（每任务一笔、随时可推）。
