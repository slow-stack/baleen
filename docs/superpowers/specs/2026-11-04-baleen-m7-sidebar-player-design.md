# Baleen 侧栏播放器（M7）—— 设计文档

- **状态**：待评审 —— 播放 tab 的**落点**（原生右栏 / 底部工作台）§3 探针定，本文按分支写
- **日期**：2026-11-04
- **上游**：主设计文档 §V5（内嵌播放器，已于 2026-11-02 落地在抽屉里）、收藏夹设计（抽屉交互面）
- **外部依赖**：`dsh-better-sidebar` 0.28.2，本机 desktop profile 已装（`node_modules/dsh-better-sidebar`），扩展点为 `ctx.betterSidebar`
- **本轮不新增 npm 依赖**：接入用的是**服务名**，不是包名（见 §5.2）

---

## 0. 一句话

视频在 DSH 里看完，不去平台：抽屉里已经能内嵌播（V5），这一轮把同一个播放器搬到侧栏，并让会话里点开的 B 站/YouTube 链接落进侧栏而不是系统浏览器。

**动机不变**：从浏览器打开等于把人送回视频平台，与插件初衷相反（这条判断出自 `docs/verification.md` V5 一节，2026-11-02）。

---

## 1. 目标与非目标

### 目标
1. 侧栏（或工作台，见 §4）里有一个 Baleen 播放页：给它一个视频 URL，它在容器内播。
2. 侧栏播 B 站时**裁掉完整页自带的相关推荐**——否则等于把半个 B 站首页装进侧栏，与 §0 的动机正面冲突。
3. 会话里点 B 站/YouTube 链接能落进这个容器（可关）。
4. 面板抽屉里加一个显式「侧栏播放」按钮，作为不依赖外链接管的兜底入口。
5. 消除现在两处互相打脸的文案：卡片写"只能跳转"（`src/client/views/video.js:51`），抽屉已经能内嵌播。

### 非目标
- 不做播放进度记忆、倍速、弹幕、字幕跟随播放。
- 不在侧栏做收藏、调权重、判读——侧栏只读地展示与播放（理由见 §6）。
- 不接管小红书图文与文章链接（只认视频域）。
- 不为了侧栏放宽 `/open` 的 URL 来源守卫。

---

## 2. 决定清单

| # | 决定 | 状态 |
|---|---|---|
| D1 | 侧栏只当播放器，不把整个面板搬进侧栏 | 已拍板 2026-11-04 |
| D2 | 全局认领视频外链 + 开关 + 面板按钮兜底 | 已拍板 |
| D3 | 侧栏裁掉推荐区（抽屉保持完整页） | 已拍板 |
| D4 | 开关放 baleen 设置页（新增布尔偏好），不用 better-sidebar 自带的 tab 启停 | 已拍板 |
| D5 | 播放容器落点（原生右栏 vs 底部工作台）由 §3 真机探针决定 | **待探针** |
| D6 | 探针同时销掉 V5 遗留的"内嵌播放器未真机验收" | 已排入 §3 |

---

## 3. 阶段 0：真机探针（先于任何代码）

当年撤掉「侧栏打开」按钮的实证原因是：**宿主原生侧栏开页签要求"当前有会话在前台"，面板在前台时永远不满足**（`src/client/views/drawer.js:239-250` 注释）。这一条今天仍然可能成立，且 better-sidebar 的 `openTab` 恰好分成两条路（`service.d.ts:680-691`：带 `path`/`url` 的 open 走原生侧栏，不带的落它自己的底部工作台）。落点不能拍，必须实测。

手法沿用 zcode 项目记忆「DSH 真机 UI 调试手法」：坐标 `click` + `strategy:"event"`；DevTools 先停靠再敲键盘；**重启一律优雅关窗，禁止强杀**（会写坏会话日志）。重启前先 `grep baleen ~/.dsh/profiles/desktop/cordis.patch.yml`（宿主 profile 那份，**不是仓库这份**）确认 link 装配条目还在——宿主运行中会重写它，条目丢了插件整个不加载。

四条探针，每条都要留下可核对的证据（截图或 console 回读），验完即删探针代码：

| 探针 | 验什么 | 通过判据 | 结论去哪 |
|---|---|---|---|
| P1 | 抽屉内嵌播放器真机能不能播 | B 站条目抽屉里 iframe 出现且点播放后画面在 iframe 内动 | 销 `docs/verification.md` V5 未验项 |
| P2 | baleen 客户端能不能拿到 `betterSidebar` | 两种注入形态分别试：`_footer.txt:17` 的 `inject` 数组加 `'betterSidebar'`；`package.json` 的 `dsh.client.inject` 加包名。任一种能取到服务即记录该形态 | 决定 §5.2 写法 |
| P2b | **没装 better-sidebar 时 baleen 还加载不加载** | 把 better-sidebar 从 profile 临时摘掉（或用禁用开关）后重启，Baleen 面板仍能开、工具面仍是六个 | 决定软探测够不够、还是要条件注入 |
| P3 | `openTab` 落点 | 分别试 `openTab({type:'dsh-baleen:player', url})` 与 `openTab({type:'dsh-baleen:player', meta:{url}})`，记录各自出现在原生右栏还是底部工作台、是否需要前台会话、窄栏里 16:9 可用高度 | 决定走 §4 分支 A 还是 B |
| P4 | 外链接管是否生效 | 会话里点一条 B 站链接：被认领进容器 = 通；仍去系统浏览器 = 记录 `linkOpening` 当前值 | 决定 D2 的"全局认领"是否可用 |

**探针之后只有两种收场**：P3 任一形态可用 → 按 §4 对应分支实现；两个形态都撞墙 → 本轮降级为"只做 P1 已证的抽屉播放 + §5.4 文案修正"，侧栏那半写进 `docs/verification.md` 的未验表并停下报因。

---

## 4. 分支 A / 分支 B（只差入参，组件不动）

- **分支 A（原生右栏）**：seed 带 `url`。tab 组件从 `tab.path`/`tab.url` 读地址（better-sidebar 的 `urlTarget` 认领链路本身就是用 `openTab({ type, url, title: hostname })`，URL 落在记录 `path` 上，见 `service.d.ts:215`）。观感是"右侧栏"，符合 D1 的字面预期；风险是再撞前台会话那条限制。
- **分支 B（底部工作台）**：seed 只带 `meta: { url, title }`（`SidebarTab.meta` 要求 JSON 可序列化并随布局持久化，`state.d.ts:52-54`）。不受原生侧栏限制，但严格说它在会话下方，不是右侧栏——**若 P3 只剩这条路，要在 §11 验收里明说"侧栏"名不副实**，由用户决定是否接受。

两分支共用同一个 tab 组件与同一套裁切逻辑，差异只在注册时的 seed 形状与取 URL 的字段，所以探针不会导致重写。

---

## 5. 组件与改动面

### 5.1 `src/client/views/player-tab.js`（新增）
播放器外壳，纯视图，输入 `{ url, title, crop }`，输出 vnode：
- 复用 `playerEmbed(url)`（`src/client/views/drawer.js:41`）拿嵌入形态，**不在新文件里重抄正则**——两处各写一遍必然漂移。
- 解析不出嵌入形态（含 `b23.tv` 短链）：不硬猜，渲染一句真话"这条地址解析不出嵌入形态，只能去浏览器看"。
- `crop` 为真时（侧栏默认）：固定 16:9 容器 + `overflow:hidden` + iframe 顶对齐，只露播放器与标题条；容器带一个 `data-bl-crop` 标记，遮罩失效时可关（§8）。
- 颜色一律走宿主 token（`test/css.test.js` 的 `HOST_TOKENS`），不写死颜色，不给 `var()` 加 `light-dark()` 兜底。

### 5.2 `src/client/sidebar-tab.js`（新增）
注册 tab descriptor：`id: 'dsh-baleen:player'`、title/description 如实（宿主 new-tab 列表 ≤4 条才显示描述，`service.d.ts:150-160`）、`component` 桥到 5.1、`urlTarget` 只认 http(s) 且**只认解析得出嵌入形态的** `bilibili.com/video/BV…` / `youtube.com/watch?v=` / `youtu.be/…`。
- **`b23.tv` 短链不认领**：解析不出 BV 号，认领进来只会开一个"这条播不了"的死端 tab，比让它去系统浏览器更糟（`service.d.ts:215` 认领顺序是先到先得，抢了就没别人份）。抽屉里的短链条目仍按 §5.1 明说"只能去浏览器"。
- 实例策略定死：`single: false` + `dedupeKey: tab => tab 的 URL`（照 browser 内置 tab 的逐 URL 模式）——同一视频复用已开的 tab，不同视频各开一个。
- 注册段包 `try`，并把结果写进 diagnostics（沿用工具注册探针 `tool_registered` 的教训：静默中断过一次）。
- 软探测：取不到 `betterSidebar` 就整段不注册，面板其余功能照旧，且**绝不裸读 `ctx.betterSidebar`**（Proxy 上未注入即抛，AGENTS.md 已实证）。
- 注入形态由 P2 决定；**不新增 npm 依赖**（`dsh-better-sidebar` 只作为服务名消费，类型合并用不上——本仓库是 JS）。

### 5.3 抽屉与卡片
- 抽屉「原文」段（`src/client/views/drawer.js:243-252`）在「浏览器打开」旁加「侧栏播放」，按 P2b/P3 结果决定按钮是否存在（服务不可用就不画，不摆死按钮）。
- `src/client/views/video.js:51` 卡片尾标改为按 `playerEmbed` 分支：能内嵌的写"抽屉里能播"，解析不出的才写"只能跳转"。

### 5.4 生成链（容易静默失效的一处）
新文件必须登记进 `tools/build-client.mjs:23-24` 的 `PARTS`，并跑 `node tools/build-client.mjs` 重新生成 `client.js`。漏登记的表现是**面板毫无变化、也不报错**（AGENTS.md 已记）；`test/build.test.js` 有"每个 `src/client/*.js` 都在 PARTS 里"的守卫，靠它兜。同名 `const` 会撞 `SyntaxError`（各文件内联进同一作用域），节点工厂一律用 `src/client/vnode.js` 的 `vnode()`。

---

## 6. 数据流与一条硬边界

```
面板抽屉点「侧栏播放」 ─┐
                        ├→ ctx.betterSidebar.openTab(seed) → tab 组件 → playerEmbed(url) → iframe
会话里点 B 站/YouTube ──┘        （P3 决定 seed 形状）
```

**硬边界**：侧栏容器拿到的是 URL 字符串，没有 `item_id`。而宿主 `/open` 路由**故意不接受调用方传入的 URL**，只按 id 查库取址（`index.js:445-470`），这条守卫是有意的，**不为了侧栏放宽**。所以：
- 侧栏内不提供"去浏览器"按钮；需要时回面板用既有的「浏览器打开」。
- 侧栏 tab 不查库、不读 items 表，纯展示传入的 URL——它不知道也不需要知道这条的档位和归属。
- 面板 → 侧栏只传 `{url, title}`，不回传状态，避免两条挂载路径互相写。

---

## 7. 降级与错误处理

| 情况 | 表现 |
|---|---|
| better-sidebar 未装 / 被禁用 | 不注册 tab、不画「侧栏播放」、外链不接管；面板其余功能不变（P2b 负责证明这一点） |
| 服务取到但 `openTab` 抛 | 按钮点了给一句"侧栏没接住，回抽屉里播"，不静默 |
| YouTube 作者关了外链嵌入 | 沿用 V5 实证结论：iframe 内显示 YouTube 自己的提示，容器文案如实说"这条平台不让嵌"，不做二次猜测 |
| 裁切遮罩随 B 站改版错位（误伤控制条） | §8 的遮罩开关关掉，回到完整页可滚；这是已知脆弱点，写进验收项而不是假装没有 |
| 解析不出嵌入形态 | 不渲染播放器，只渲染那句真话 |

失败不推进游标、重试上限 1 次这些抓取侧约束本轮不涉及（不碰 `runner.js`）。

---

## 8. 偏好与开关

- 新增布尔偏好 `sidebar_takeover`，**默认开**：控制是否注册 `urlTarget` 认领视频外链。关掉 = 外链照旧去系统浏览器，侧栏 tab 仍注册（面板按钮仍可用）。
- 新增布尔偏好 `sidebar_crop`，**默认开**：控制侧栏是否裁掉推荐区。关掉是给"改版遮罩错位"留的后路。
- 两者都走现有 flag 路径（设置页 checkbox 绑 pref 键，同 `inject_prompt` 那条）与现有 `PUT /api/dsh-baleen/preference`，**不新增路由、不新增工具**。
- 注意红线 8：这两个布尔属于 `flags`，不是 `tuning`；两个粗调按钮只写 `tuning` 的既有约束不变。

---

## 9. 红线在这一页上的具体化

- **工具面恰好六个**（`test/tools.test.js` 盯）：本轮不注册任何 agent 工具，侧栏播放只是 UI。
- **绝不注册平台写操作**：不接管点赞/收藏到平台/评论；侧栏 tab 连"收藏"按钮都不放（§6）。
- **不新增 npm 依赖**：只消费服务名（§5.2）。
- **脱敏**：diagnostics 与日志不含用户名、家目录绝对路径、token/cookie；外链 URL 记日志时只记主机名与 BV/vid 形态，不整条落盘。
- **明暗双主题都是验收项**：裁切容器与 tab 文案只用宿主 token。

---

## 10. 测试

`node --test "test/*.test.js"`（Windows 下不能用 `node --test test/`）。新增/改动：

1. `test/views-player-tab.test.js`（新）：`playerEmbed` 三态在 tab 里的表现——B 站完整页 + 裁切容器存在、YouTube embed、短链/未知平台渲染"只能跳转"那句且不画 `bl-player`；断言 tab 视图**不含**收藏与权重按钮（守 §6）。
2. `test/views-drawer.test.js`（改）：现有 `playerEmbed` 断言保持；新增「侧栏播放」按钮在 embed 存在时出现、在服务不可用时由装配层不传而不渲染。
3. `test/views-video.test.js`（改）：卡片尾标随 `playerEmbed` 分支——B 站 BV 条目不再写"只能跳转"。
4. `test/build.test.js`：产物逐字节 + PARTS 覆盖新文件（自动生效，不改）。
5. `test/css.test.js`：裁切容器只用已在 `HOST_TOKENS` 里的名字，新 token 名一律不许出现。
6. `test/tools.test.js`：红线测试必须仍绿，且断言本轮没有新增工具。

---

## 11. 真机验收（走 P1–P4 之后的第二轮）

- 明暗两主题各截一张侧栏播放图，确认裁切只露播放器+标题、控制条没被遮。
- 会话里点 B 站链接 → 落容器；`Ctrl+click` → 仍能去系统浏览器（better-sidebar 的接管对带修饰键的点击**总是绕过**，`link-intercept.d.ts:12`）。
- 设置页关掉 `sidebar_takeover` 并重启装配 → 外链不再被认领，「侧栏播放」按钮仍在。
- 摘掉 better-sidebar 重启 → Baleen 面板照常加载、工具面六个（P2b 的正式版）。
- 抽屉内嵌播放真机可播（P1 结论落到 `docs/verification.md`）。
- **未验项如实记录**，不许写成通过：窄栏下的实际可用高度、宿主版本升级后 `urlTarget` 认领顺序变化、B 站改版导致遮罩错位的复发频率。

---

## 12. 本设计不做

- 不做 B 站 bare player（`player.bilibili.com/player.html`）路线——V5 实测它是空壳（指纹脚本报错），已在 `docs/verification.md:405` 记死。
- 不 fork、不注入 CSS 到播放器 iframe 内部（跨源读不到，也不该读）。
- 不做"侧栏里刷推荐流"——那正是 D3 要裁掉的东西。
- 不改 `runner.js`、`scheduler.js`、判断轮与词表。

---

## 13. 影响面（改哪些文件）

| 文件 | 改动 |
|---|---|
| `src/client/views/player-tab.js` | 新增 |
| `src/client/sidebar-tab.js` | 新增 |
| `src/client/_footer.txt` | 按 P2 结论加服务注入；装配层挂注册；抽屉按钮回调传递 |
| `src/client/views/drawer.js` | 「侧栏播放」按钮 + `boundaryNote` 文案随分支更新 |
| `src/client/views/video.js` | 卡片尾标改判 |
| `src/client/views/settings.js` | 两个新 flag |
| `src/client/css.js` | 裁切容器样式（只用宿主 token） |
| `tools/build-client.mjs` | `PARTS` 加两个新文件 |
| `client.js` | 重新生成（不手改） |
| `lib/preference.js` | 两个布尔默认值与校验 |
| `docs/verification.md` | P1 结论 + 未验表更新 |
| `test/` | §10 四条 |

---

## 14. 落地次序

1. §3 探针（P1→P2→P2b→P3→P4），结论回填本文 §4 与 §2 的 D5。
2. 探针结论确定后写实现计划（writing-plans），按 §13 顺序落文件，每步跑 `node --test "test/*.test.js"` + `npm run build:check`。
3. 真机验收（§11），一次提交一个任务，提交信息用中文。
