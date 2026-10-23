# Baleen — 给协作 agent 的项目说明

Baleen 是一个 DSH（DeepSeek Harness 桌面版）插件：定时把信息源灌进本地库，用**读正文/字幕**而不是读标题的方式筛掉劣质内容，每轮自动出一份增量汇报。名字来自鲸须（滤食结构）。

设计文档：`docs/superpowers/specs/2026-10-23-baleen-design.md`
当前实现计划：`docs/superpowers/plans/2026-10-23-baleen-m0m1-store-and-rss.md`
实测记录：`docs/verification.md`

## 硬约束（每个改动都要守）

1. **零新增 npm 依赖**为首选。目前只允许 `yaml`（纯 JS、无 install 脚本）。要加别的先停下来问。
2. **绝不注册平台写操作**。没有评论、私信、点赞、关注、发布。判断那一轮只给只读工具。这是产品红线，不是"以后再说"。
3. **失败不推进游标**。抓取失败的源必须保留旧游标，让下一轮能补缺口。`test/runner.test.js` 里有一条测试直接盯这件事，别让它变成摆设。
4. **重试上限 1 次**。超限就记 `failed` 继续下一个源。禁止为了让某个源成功而写临时调试脚本——那是烧钱的思路。
5. **`body_state` 六值固定**：`full` `summary_only` `subtitle` `transcribed` `missing` `burned_in`。`missing`（没有语音）与 `burned_in`（字在画面里读不到）是两种记录，合并它们等于对用户谎报覆盖面。
6. **三档词固定**：`值得看` `可以看` `不值当`。不许自创档位，不许写分数。
7. **日志与诊断脱敏**：不含用户名、不含家目录绝对路径、不含 token/cookie。测试里也不要出现真名，用 `os.homedir()` 做比较。
8. **两个粗调按钮只写 `tuning`**，永远不改 `themes` / `follow` / `sources`。
9. 测试只用 `node --test`。不引入 jest / vitest。**注意 `node --test test/` 在 Windows 上会把目录当模块解析而报错**，一律写 `node --test "test/*.test.js"`（`npm test` 已经是这个形式）。
10. 提交信息用中文；一个任务一次提交。

## 本机的坑（已实证，别再撞）

- 工作副本是 **CRLF**。多行锚点的脚本要匹配 `\r?\n`。
- 编辑工具可能**静默删掉文件内容里的 Windows 绝对路径**。写含路径的文件后要么用脚本拼接，要么读回验证。
- DSH 客户端 `ctx` 是 **Proxy**：服务名没写进 `package.json` 的 `dsh.client.inject`，`ctx.get()` 和属性访问都会抛。`try { ctx.get(x) } catch {}` 之后再去裸读 `ctx.x` 是炸启动的写法，不是安全降级。
- 侧栏入口 `sidebar.panellist` 注册的 `id` 必须与 `main` 面板的 key **完全同名**，否则宿主 `layout.selectPanel` 抛。
- 主题只消费宿主 token（`--dsw-alias-*`），**明暗双主题都是验收项**，不写死颜色。
- 面板布局别留两侧大空白；网格用 `auto-fill minmax(260px, 1fr)`。
- 打包 node 的入口是 `resources/runtime/bin/node.cmd`，需要 `DSH_DESKTOP_NODE_EXECUTABLE` 指向 `DeepSeek Harness.exe`（细节见 `docs/verification.md`）。
- 动 DSH profile 之前：**备份 `cordis.patch.yml` 和 profile `package.json`**，一次只切换一个插件，**永远不要点启动失败弹窗里"禁用第三方插件、备份 profile patch 并重启"那个按钮**（它会重新序列化并清掉文件）。
- 装完插件先用 `dsh --profile desktop --dump-config` 检查装配，别用重启试错。

## 界面协作约定

- 新建 UI 元素前先看有没有现成参照（`D:/dsh-study-desk` 是本机已验证的写法）。
- 面板属于 v1，不许在规划时把前端收窄掉。
- 定稿前给假数据 HTML 预览，明暗两版都能看。
- 拍板类问题给封闭选项，别让人打字。
