# 参与开发

欢迎提 issue 和 PR。这个仓库有几条硬约束，不是风格偏好——它们对应真实踩过的坑，破了会静默坏掉。

## 先跑起来

```bash
npm install
npm test              # node --test，578 条，不需要网络
npm run build:check   # 验证 client.js 与 src/client/ 同步
node tools/preview.mjs  # 出 out/preview-*.html，明暗两版，浏览器直接看
```

不需要装 DSH 就能改前端——预览调的就是 `src/client/views/` 里的真渲染函数。

## 硬约束

1. **零新增 npm 依赖**是首选。目前只允许 `yaml`（纯 JS、无 install 脚本）。要加别的，先在 issue 里说清楚为什么标准库做不了。
2. **绝不注册平台写操作**。没有评论、私信、点赞、关注、发布、收藏到平台。判断轮只给只读工具。这是产品红线，PR 碰到这条直接关。
3. **失败不推进游标**。抓取失败的源必须保留旧游标，下一轮补缺口。`test/runner.test.js` 有测试盯这件事，别把它改成摆设。
4. **重试上限 1 次**。超限记 `failed` 继续下一个源。
5. **`body_state` 六值固定**：`full` `summary_only` `subtitle` `transcribed` `missing` `burned_in`。`missing`（没有语音）与 `burned_in`（字烧在画面里）是两种记录，合并等于对用户谎报覆盖面。
6. **三档词固定**：`值得看` `可以看` `不值当`。不许自创档位，不许写分数。
7. **日志与诊断脱敏**：不含用户名、不含家目录绝对路径、不含 token/cookie。测试里也别写真名。
8. **工具面恰好六个**，`save_verdicts` 是唯一写工具。名字与设计文档 §10.1 逐字对应。

## 本机实测过的坑（别再撞）

### 文件与编码

- 工作副本是 **CRLF**。多行锚点的脚本要匹配 `\r?\n`。
- 编辑工具可能**静默删掉文件内容里的 Windows 绝对路径**。写含路径的文件后要读回验证。
- `client.js` 是**生成产物，别手改**。源在 `src/client/`，改完跑 `node tools/build-client.mjs`；`build:check` 只做新旧比对。
- 生成方式是把多个源文件**内联进同一个 factory 作用域**（只剥 `import`/`export` 行），所以**两个源文件里的同名 `const` 会直接 SyntaxError**。节点工厂统一用 `src/client/vnode.js` 的 `vnode()`。
- 新加视图忘了登记 `tools/build-client.mjs` 的 `PARTS`，面板不会有任何变化，也不会报错——`test/build.test.js` 有条守卫盯这个。

### 宿主装配

- 宿主 API 实测形态：取服务用 `ctx.get('webServer') ?? ctx.webServer`；注册路由用 `webServer.register({ kind:'prefix', path, handler })` 且必须包在 `ctx.effect(fn, label)` 里；注册服务用 `ctx.provide`（`ctx.set` 对未 provide 的服务会抛）。
- DSH 客户端 `ctx` 是 **Proxy**：服务名没写进 `package.json` 的 `dsh.client.inject`，`ctx.get()` 和属性访问都会抛。`try { ctx.get(x) } catch {}` 之后再去裸读 `ctx.x` 是炸启动的写法。
- 工具/注入走 `ctx.inject`：工具 `ctx.inject(['tools'], (c) => c.tools.register(t))`、注入 `ctx.inject(['systemPrompt'], (c) => c.systemPrompt.context({ name, order, text }))`。旧的 `ctx.on('system-prompt/assemble')` 在新宿主上不存在。
- 定时器一律走 `ctx.effect(() => { const h = start(); return () => stop(h) })`；测试里通过 `apply(ctx, { setInterval, clearInterval })` 注入替身，否则真 interval 会把 `node --test` 吊住不退出。
- 改完插件代码**必须重启 DSH** 才装配。宿主运行中重写 `cordis.patch.yml` 会把 link 装配条目丢掉，重启前先 `grep baleen cordis.patch.yml` 确认。
- 动 DSH profile 之前备份 `cordis.patch.yml` 和 profile `package.json`。**永远不要点启动失败弹窗里「禁用第三方插件、备份 profile patch 并重启」那个按钮**（它会重新序列化并清掉文件）。

### 样式

- 主题只消费宿主 token（`--dsw-alias-*`），**明暗双主题都是验收项**，不写死颜色。本机实测存在的名字见 `test/css.test.js` 的 `HOST_TOKENS`。`fill-tertiary`、`border-primary`、`link` **不存在**——写错不是风格问题，是宿主取不到值。也不给 `var()` 加 `light-dark()` 兜底。

### 数据库

- `node:sqlite` 在本机可用（node 24.x），不要引第三方 DB。
- `digests.run_id` 是 `NOT NULL`：测试里手工插 digest 或调 `saveVerdicts` 前必须先 `createRun(db, 'schedule', () => N)`。
- 加列走 `lib/store.js` 的 `migrate(db)`：先 `PRAGMA table_info` 判断，再 `ALTER TABLE ... ADD COLUMN`，让老库能原地升级。

## 测试

只用 `node --test`，不引入 jest / vitest。

**注意 `node --test test/` 在 Windows 上会把目录当模块解析而报错**，一律写 `node --test "test/*.test.js"`（`npm test` 已经是这个形式）。

改完代码至少跑 `npm test` + `npm run build:check`，两个都绿再提 PR。

## 提交规范

- **提交信息用中文**，一个任务一次提交。
- **不留 AI 署名**：不写 `Co-authored-by: <AI>`、不写 "Generated with ..." 之类脚注。
- PR 标题写清「改了什么 + 为什么」，正文贴测试输出。
- 一次 PR 只做一件事。顺手重构和功能混在一起会被要求拆开。

## 分支

`main` 是受保护分支：直推被拒，改动走 PR，且必须等 CI 绿。

## 许可

提交即表示你同意以 [Apache License 2.0](LICENSE) 授权你的贡献。
