# 实测记录

实测日期：2026-10-23。宿主：DSH 桌面版 **0.2.1-rc.2**（`dsh -V` 输出）。
结论只覆盖这台机器；换机器必须重跑 `node selfcheck.mjs`。

## V1 · `node:sqlite` 可用性 → **通过，store 用 sqlite，不启用退路**

| 运行时 | 版本 | 结果 |
|---|---|---|
| 本机独立 node | v24.15.0 | OK |
| DSH 打包 node | 24.21.0（`resources/runtime/primary-runtime/runtime.json` 声明） | OK |

`selfcheck.mjs` 的原样输出（两个运行时一致）：

```text
node:sqlite OK [{"id":1,"name":"值得看"},{"id":2,"name":"标题党「十款工具」"}]
```

建表、插入、查询、中文与全角符号往返全部通过。

打包 node 的调用方式是个坑，单独记下来：`resources/runtime/bin/node` **没有 `.exe`**，真正的入口是 `bin/node.cmd`，内容就三行：

```bat
@echo off
set ELECTRON_RUN_AS_NODE=1
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*
```

所以必须先设 `DSH_DESKTOP_NODE_EXECUTABLE` 指向 `D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe` 才调得动；不设就直接失败。设好后跑通。

**结论**：`lib/store.js` 按 `node:sqlite` 实现，Task 1–9 不需要 JSONL 退路。插件在宿主进程里用的就是这个 Electron 壳，本机开发用独立 node，两边都验过。

## V2 · headless 会话能不能被插件起来 → **入口确认，真实一轮未测**

`dsh --help` 的相关原文（只摘这几行）：

```text
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  dsh headless "run the tests"   answer one task, print the result, and exit
  dsh plugin --profile tui add <package>   install a plugin into the tui profile
```

- `--profile` 本机实存的值：`desktop`、`headless`、`web`、`verify-euthyna`（`$DSH_HOME/profiles/` 目录列举）。
- **一次性非交互执行是文档化的用法**：`dsh headless "<任务>"` 明确写着 "answer one task, print the result, and exit"，这正是 `digest` 需要的那条通道。
- `dsh --profile headless --dump-config` 返回 rc=0 且**不启动应用**，输出里能看到 headless 那层的装配含 `llm`（`@deepseek-ai/dsh-llm`）、`session`（`@deepseek-ai/dsh-session`）、`typert-*`，即模型会话能力在这一层是齐的。
- **真实起一轮 = 未测**。原因：那会消耗你的模型额度并产生会话记录，属于要你点头的对外动作，不属于"只读探测"。
- **结论**：M3 可以按"自动起 headless 一轮"设计，但手动兜底（面板"现在跑一轮"）必须留在架构里，等 V2 的真实一轮跑过才能谈取消。

## 附带发现（会影响后续任务，先记在这儿）

1. **宿主 base 里已经有一个 timer 插件**：`--dump-config` 输出里 `@deepseek-ai/dsh-base` 层带着

   ```yaml
   - id: timer
     name: '@deepseek-ai/cordis-plugin-timer'
   ```

   也就是说定时能力宿主本来就有。**M1 仍然按计划的自建 `setInterval` 实现**（Task 9），理由是：不依赖 profile 配置层的可变性、逻辑可单测、换 profile 也带着走。但 M3 起判断轮之前要评估一次改用宿主 `timer`（新增待验证项 V7）——如果宿主 timer 支持按插件配置注册任务，就能省掉我们自己的锁语义。
2. **`--dump-config` 是免费的验收工具**：M1 装完插件后，不用重启 DSH 就能先看我们的 bundle 有没有被装配进去。已把它加进 Task 11 的装载前检查。
3. `dsh plugin --profile <name> add <package>` 与 `link:` 的安装路径在 help 里确认存在；本机三个 profile 各有一份独立 `node_modules`，**桌面版要装进 `desktop`**（这条与既有记忆一致）。

## V6 · feed 真实覆盖率 → **已测（5 个公开源 / 80 条 / 2026-10-23）**

跑法：`cp preference.example.yaml <BALEEN_HOME>/preference.yaml` 后
`BALEEN_HOME=D:/tmp/baleen-live node tools/live-ingest.mjs --reset`（不经 DSH、假 ctx、独立临时家目录，不碰 `~/.dsh/baleen`）。

| 源 | 类型 | 抓回 | full | summary_only | 结果 |
|---|---|---|---|---|---|
| Cloudflare Blog | RSS2 | 20 | 20 | 0 | 在 `follow.feeds` 里 → 全部进候选 |
| Pragmatic Engineer | Substack | 20 | 17 | 3 | 14 条 `stale`（feed 里含三个月前的旧文），6 条候选 |
| Medium·Addy Osmani | RSS2 | 10 | 10 | 0 | 10 条全部 `stale`（该作者更新慢），超龄判定生效 |
| 少数派 | RSS2 | 10 | 0 | 10 | 中文源只给 `description` → 全部 `summary_only` |
| HN frontpage | RSS2 | 20 | 0 | 20 | 只有一行摘要，正常 |

不可达的候选（探活记录）：simonwillison.net/atom.xml → 404；ruanyifeng.com/blog/atom.xml → 403；martinfowler.com/feed.atom → TLS 吊销列表离线（本机网络约束）。

结论三条：

1. **Substack 与 Medium 都能拿到 `content:encoded` 全文**，不需要绕付费墙；Medium 这轮没触发付费墙样本，要在她自己的订阅上复测。
2. **中文源与聚合源默认只有摘要**，所以文章区的"仅摘要"徽章是常态而不是错误态，面板文案不能把它写成异常。
3. `max_age_days` 目前是全局值，对更新慢的源会整源清空（Medium 那 10 条全灭）。已记入 M5 设置页需求：**按源覆盖 `max_age_days`**。

同一轮真数据还暴露三个产品级缺陷（英文关键词子串匹配造出假命中理由、来源权重让 `below-score` 形同虚设、启动时不镜像偏好）。修法与改前/改后数字（56 候选 → 26 候选 / 54 丢弃）见实现计划对应小节。

## profile 改动：故意没做

DSH 此刻正在运行（5 个进程，19:07 起）。**在应用运行时改 `cordis.patch.yml` / `package.json` 正是本机那次"配置被清空"的前置条件**（应用在运行中会自己重写该文件），所以 link 安装与重启留到应用退出之后：由她退出，agent 再装并用 `--dump-config` 校验。

备份与基线已就位：`cordis.patch.yml.bak-before-baleen-1792753753`、`package.json.bak-before-baleen-1792753753`；patch 40 条 / 54866 B、依赖 36、bundles 47。

## 还没测的项

| 项 | 状态 | 阻塞在哪 |
|---|---|---|
| V3 小红书 MCP 代码审查 | 未开始 | 属于 M4，且要装第三方带登录态的代码，需你批准 |
| V4 `settings.section` 在桌面版是否出现 | 未开始 | 需要真的装插件 + 重启，属于 Task 11 |
| V5 B 站内嵌播放器 | 未开始 | 需要面板存在，属于 M2/M4 |
| V7（新增）宿主 `timer` 能否替代自建调度 | 未开始 | M3 前评估，不影响 M1 |

## 隐私与脱敏说明

本文档不含用户名、家目录绝对路径、token/cookie。DSH 安装目录与 runtime 路径是公开安装路径，可以写；`$DSH_HOME` 一律写成 `~/.dsh` 或"由 `DSH_HOME` 指定"。
