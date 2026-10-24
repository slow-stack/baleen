# Baleen 收藏夹 —— 设计文档

日期：2026-10-24　状态：待用户过目　隶属：`2026-10-23-baleen-design.md`（主 spec）的增补

一句话：给条目加**本地收藏夹**——一个永远在的默认夹 + 你自己建的夹，收藏页成为面板的第六格。收藏只写本机库，**绝不触碰任何平台的收藏/点赞接口**。

---

## 1. 这次为什么会撞名（先解决语义地基）

抽屉里现有的那颗按钮叫「收藏」，但它不收藏任何东西：它把该来源权重 `+0.1` 写进 `tuning`（`feedback='save'`）。真收藏夹一加进来，同一个词在同一个面板里就是两种意思，而且是两种**后果完全不同**的意思（一个改推荐倾向，一个只是你自己留档）。

**决定 D13**：现有按钮改名「**这源多来点**」，"收藏"这个词整个让给收藏夹。

- 行为不变：仍是 `source_delta += 0.1`、限幅 ±0.5、只写 `tuning.json`、不动 `themes`。
- 改名波及：`src/client/views/drawer.js`（按钮文案 + `feedbackHint('save')`）、`test/views-drawer.test.js`（两处断言）、主 spec 第 233 行与第 351 行的措辞、M5 设置页文案。
- 不改名波及：`/feedback` 的 action 字面量 `'save'` **保留**（它是协议字段不是给人看的词），改了会牵动宿主路由测试与已有 `tuning.json` 的读法。

---

## 2. 决定清单

| # | 议题 | 决定 | 代价 / 被否掉的走法 |
|---|---|---|---|
| D14 | 一条能进几个夹 | **多对多**：`folder_items` 关系表 | 单夹方案（items 存一列）更省，但默认夹和自建夹会互相抢，"这条既属于主题又属于要精读"表达不了，且误移会静默抹掉上一个归属。标签方案（平铺）否：你要的是"收藏夹"，标签堆到二三十个没有夹子好扫 |
| D15 | 收藏与条目生命周期 | 收藏**豁免过期再归档**；已归档的条目收藏后**不复活**，但收藏页**不限状态列出** | 复活要"归档前是 new 还是 judged"，而那只存过一次，改了就得新增列，并且会把它重新变成判断轮候选，与"已判不重判"的成本约束顶牛。"不给收"否：那种点不动的界面最烦人 |
| D16 | 入口位置 | 顶部导航**第六格「收藏」**，顺序 今天/视频/文章/收藏/汇报/库 | 塞进「库」否：库是多选筛选的检索页，收藏是"我要回来看的东西"，混用每次要点两下。侧栏再挂一个入口否：宿主 `layout` 要注册两个 main key，本机只验证过单入口形态，真机风险大 |
| D17 | 收藏是否影响推荐 | **完全不影响**：不进 `themes`、不进 `tuning`、不写进 M3 的系统提示注入 | 收藏常是"以后写东西要用"，与"这种内容多推点"是两件事，混进去模型一定猜错意图。一键转主题词 / 自动加权两种都被否 |
| D18 | 存储形状 | **A：`folders` + `folder_items` 两张新表** | B（items 存 JSON 列）：改名/删夹要全表重写、按夹查走不了索引、默认夹"不可删"无处安放；C（夹清单进 `preference.yaml`）：面板写 yaml 会吃注释（`tuning.json` 那条教训刚踩过），等于 UI 和你同时拥有同一份定义 |

---

## 3. 数据模型

```
folders(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
)

folder_items(
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (folder_id, item_id)
)
```

- **级联的前提已经在了**：`lib/store.js` 的 `openStore` 现在就有 `PRAGMA foreign_keys = ON`，所以 `ON DELETE CASCADE` 真会执行。删夹只删关系，条目一条都不动；条目被彻底删除时收藏关系不会残留。
- **`items` 表不加任何列**。"这条在哪些夹里"从 `folder_items` 现取。
- **默认夹**由 `migrate` 插入（`name='默认'`、`is_default=1`）。新库靠 DDL，老库靠 `INSERT OR IGNORE` + 只在 `SELECT COUNT(*) WHERE is_default=1` 为 0 时插入，**重复执行 migrate 不炸**（这条要有幂等测试）。
- 默认夹**可改名**（改名后 `is_default=1` 的身份不变，收藏的默认落点仍指向它）、**不可删**（路由与 store 两层都拒绝，不依赖 UI 藏按钮）。
- 名称规则：`1..40` 个字符，去首尾空白后不能为空；**超长拒绝而不是截断**；重名返回 `409 name_taken`。夹数量不设上限（本地库、不消耗模型额度，成本三道闸管不到它）。
- **默认夹永远恰好一个**：migrate 只在"没有任何 `is_default=1` 的行"时补一行，删除默认夹在路由与 store 两层都被拒。不靠 partial unique index 兜——那个约束靠"不可删"就够了，索引反而让迁移多一个特例。
- **`/folders` 的 `count` 含已归档条目**。收藏页列的是"你收过的东西"，而它查询不限状态（§5）；夹上写 5 条、点进来看见 4 条这种口径不一致，会被当成 bug 报上来。

---

## 4. 写入边界：谁能动库

四条路由，全部挂在现有 `/api/dsh-baleen` 前缀下（桌面端只有 `/api/*` 会转发到宿主，前缀不可改）：

| 路由 | 语义 |
|---|---|
| `GET /folders` | 夹列表：`id / name / is_default / count`，排序 `is_default DESC, created_at ASC, id ASC`（默认夹永远在最前，且不依赖时钟单调） |
| `POST /folder` | `{action:'create'\|'rename'\|'delete', …}`，action 走白名单，未知一律 400 |
| `POST /collect` | `{item_id, folder_ids:[…], new_folder?}` —— **全量替换**这条条目的夹成员；`new_folder` 在同一条请求里先建夹再放入 |
| `GET /items?folder=<id>` | 收藏页取数：`listItems` 增加一个 `folder` 参数，走 join，**不带状态过滤**（见 D15） |

`/collect` 的**全量替换**语义覆盖面板上所有收藏动作：抽屉里勾完提交、收藏页上"移出本夹"（提交去掉那个夹之后的集合）、以及"新建夹并放入"。`new_folder` 必须在同一次请求里做完，不能拆成"先建夹再收藏"两次调用——中间断一次就留下一个建好了却什么都没装的空夹，而面板会报告成功。

**`collect` 选全量替换而不是 add/remove 两个动作**：抽屉里那本来就是一组多选框，提交"最终这一组"少一对竞态，也少两条"重复收藏 / 漏取消"的测试。移出单个夹 = 提交去掉那个夹之后的集合。

**收藏永远走面板 → 宿主路由，不注册成 agent 工具。** 主 spec 第 10 节的分工不动：判断权给模型，写库权给你。M3 的工具面仍是 `baleen.query / read_item / run_status / subtitle` 四个只读加唯一的 `baleen.save_verdicts`；`collect` 对模型连名字都不该存在。

---

## 5. 生命周期：D15 在代码里的确切落点

`lib/runner.js:81` 是那个再归档点：某条内容本轮**重新抓到但没过闸**（例如过了 `max_age_days`），就 `setStatus(…, 'archived', 'stale:…')`。收藏的豁免加在这里：

- 已在任意夹里的条目 → **本轮不改归档**，保持原状态。
- 不在任何夹里的 → 行为与现在完全一致（这条反向断言必须有测试，防止"豁免"被实现成"关掉清理"）。
- 去重语义不动：`duplicate:` 归档的是**多出来的那一份冗余副本**，留下的一直是被收藏的那条，所以不需要额外的豁免。
- 未来若真加"清理已入库过期条目"这一步（现在没有），规则照抄：在任意夹里就跳过。

**不复活**：收藏一条已经 `archived` 的条目，只建立关系，不改 `status`。收藏页因此**查询不限状态**，并在卡上标出 `已归档：stale:20 天前`，附一句「收藏不会让它重新出现在今天」。这保证"收了就不会从收藏页消失"，同时不发明一条状态回滚路径。

---

## 6. 面板

### 6.1 导航

`VIEWS`（view-state）、`VIEW_RENDER`（装配层）、`NAV_ITEMS`（views/shell.js）**三处同名扩到六格**。现有的两条守卫测试正好盯着这类漂移，会直接指出漏改的那一处。旧的 `baleen.view` 持久化值（五格时代写的）不许把面板炸成空白。

### 6.2 收藏页 `CollectionsView`

- 布局：左侧一列夹（名字 + 条数 + 当前选中态），右侧该夹的条目网格，复用 `.bl-grid` 的 `auto-fill minmax(260px, 1fr)`。夹一多就平铺所有夹会滚不完；"点一个夹看里面"才是要的动作。窄屏（`max-width: 820px`）折成单列，沿用现有媒体查询，不新增断点。
- 工具条三件事：新建夹（输入框 + 按钮）、改名当前夹、删除当前夹。**删除走二次确认**，确认文案直接写"只删收藏关系，条目本身不动"；默认夹不出现删除按钮，但服务端照样拒绝。
- 卡面信息：标题、来源、形态、**收进来的时间 `added_at`**（这一页的时间轴是"我什么时候决定留下的"，不是发布时间），以及**它还在哪些别的夹里**。多夹归属不写出来，你移出去时根本不知道自己顺手动了哪个夹。
- 空态分两种：这个夹还是空的（说去别的页用抽屉「收藏到…」放进来）；以及库里一条都没收过。两种文案不同，不许合并成一句"暂无数据"。

### 6.3 抽屉

「收藏到…」= 一组多选（当前所属夹回填勾），末尾一行"新建夹并放入"。提交走 `POST /collect`。成功回显「已放进：默认 / 公共管理」，失败回显「没记上（原因）」——沿用现有 `bl-feedback` 那一行和"点了必须知道有没有记上"的规矩。

**卡片上不放收藏按钮**：现有卡片本身就是 `<button>`，HTML 里 button 套 button 非法（浏览器会把内层踢到外层，点击行为不可预期）。收藏入口只有抽屉和收藏页两处，这是实现约束不是审美选择。

---

## 7. 错误处理

面板唯一的真相源是 sqlite，**路由失败不许假装成功**。

| 情况 | 行为 |
|---|---|
| 提交时某个夹已被删（刚在另一格删的） | `folder_gone` + 具体是哪几个 id；面板说"有两个夹已经不在了，这次没记上"，不静默丢掉那部分意图 |
| 夹名空 / 全空格 / 超 40 字 | 400 + 人话文案；超长**拒绝**，不截断 |
| 重名 | `409 name_taken`（不是 500） |
| 删默认夹 | `403 default_folder`，store 层同样拒 |
| 收藏一个不存在的 item | `404 no_item`（FK 级联已保证删条目时关系不自杀式残留） |
| 宿主路由整个缺席 | `createApi` 现有的快照/`stale` 回落；收藏页说"读不到夹"，不画空网格 |
| 老库跑 `migrate` | 幂等：建表 `IF NOT EXISTS` + 缺默认夹才补，重复执行不炸 |

---

## 8. 红线在这一页上的具体化

- **只读世界**：代码里不存在任何指向平台收藏/点赞接口的路径。B 站 vendored MCP 在 M4 落地时按白名单只暴露 搜索 / 视频信息 / 字幕 三个只读方法；"收藏到 B 站收藏夹"这种能力连函数名都不出现。
- **判断权与写库权**：`collect` 不注册为工具（见第 4 节）。
- **收藏不是推荐信号**（D17）：不进 `themes`、不进 `tuning`、不进系统提示注入。
- **脱敏**：日志只记 `collect` 事件与夹 id，不记标题、URL、feed 地址；沿用 `lib/diag.js` 的 `redact`。
- **凭据与数据只在本机** `~/.dsh/baleen/`；不同步、不导出（导出不在本设计内）。

---

## 9. 测试

延续"纯 Node 断言 + 预览门"两条腿，没有浏览器测试之外的新工具，零新增依赖：

1. `test/store-collections.test.js` —— 建/改名/删；**级联只删关系不删条目**；`setItemFolders` 全量替换的幂等（重复提交同一集合不产生新行）；`foldersOfItem` 稳定顺序；默认夹不可删在 store 层也拦；重名报错。
2. `test/host-surface.test.js` 追加 —— 四条路由的成与败；至少钉住 `403 default_folder`、`409 name_taken`、`folder_gone` 三条；原有"`/feedback` 两个文件都不碰"的断言在按钮改名后依然成立。
3. `test/runner.test.js` 追加 —— **收过的条目第二轮 gate 失败不再被改 archived**，且**没收过的照旧归档**（反向断言，盯住"豁免 ≠ 关掉清理"）。
4. `test/views-collections.test.js` —— 左列夹与条数、选中态、两种空态文案、卡面 `added_at` 与"还在别的夹里"、删夹二次确认文案、建夹失败回显、归档条目照样列出并标明原因。
5. `test/views-drawer.test.js` 追加 —— 「收藏到…」多选提交的是集合；成功/失败/`folder_gone` 三种回显措辞；**现有按钮改名后断言跟着换**（`不感兴趣` / `这源多来点`）。
6. `test/client-boot.test.js` —— 六格在 `VIEWS`/`VIEW_RENDER`/`NAV_ITEMS` 三处一致；持久化落在收藏页；五格时代的旧 `baleen.view` 值不炸。
7. `test/css.test.js` —— 新类名（`bl-folders`/`bl-collection-grid`/`bl-addrow`/`bl-confirm`…）自动进类名双向扫描；零硬编码颜色与 token allowlist 照旧。
8. `test/preview.test.js` + `tools/preview.mjs` —— 新增 `preview-collections.html`（一个空夹、一个满夹、一条已归档但仍列出的诚实展示），抽屉页里画出「收藏到…」多选；预览门重新过一次。

---

## 10. 本设计不做

夹排序与拖拽、夹图标/配色、批量收藏（库里勾选多条一次收进夹）、收藏夹导出、跨设备同步（与凭据红线冲突，永远不做）、收藏夹参与预筛或判断、把 `collect` 暴露给模型、设置页里的夹管理（M5 再说，收藏页本身已经能建/改名/删）。

## 11. 影响面（改哪些文件）

- 库侧：`lib/sql/items.sql`（两张表）、`lib/store.js`（`migrate` 补默认夹 + 六个函数：`createFolder/renameFolder/deleteFolder/listFolders/setItemFolders/foldersOfItem`，`listItems` 加 `folder` 参数）、`lib/runner.js:81`（豁免）、`index.js`（四条路由 + 动作白名单）。
- 面板侧：`src/client/view-state.js`（`VIEWS` 六格）、`src/client/views/shell.js`（`NAV_ITEMS`）、`src/client/views/collections.js`（新）、`src/client/views/drawer.js`（改名 + 「收藏到…」多选）、`src/client/_footer.txt`（`VIEW_RENDER`）、`src/client/css.js`（新类名）、`tools/preview.mjs` + `test/fixtures/preview-data.js`（夹具加两个夹）。
- 文档：主 spec 第 233 / 351 行的措辞、`AGENTS.md`（新增"收藏只写本地库、不注册为工具"一条）、README 状态行、M2 计划的偏差记录。

## 12. 落地次序（要你拍板的一件事）

M2 现在停在**预览门**：七页假数据 HTML 等你点头，然后才真机装载。收藏功能会改六格导航、抽屉文案和预览，**所以这一版预览会作废**。

- 建议：收藏作为 **M2.5** 在真机装载之前做完，预览门只过一遍（省一次真机往返，也省一次"退出 DSH → 装载 → 重启"）。
- 替代：先按现在这版过门并真机验收 M2，再做 M2.5 —— 代价是装载与重启走两遍，你也要看两版预览。
