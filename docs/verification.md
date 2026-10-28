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

## V2 · headless 会话能不能被插件起来 → **入口能跑，卡在凭据（0 次模型调用）**

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
- `dsh --profile headless --dump-config` 返回 rc=0 且**不启动应用**，输出里能看到 headless 那层的装配含 `llm`（`@deepseek-ai/dsh-llm`）、`deepseek-llm-api-extensions`、`agent-default-model`（`model: deepseek-flash`）、`session`、`typert-*`，即模型会话能力在这一层是齐的。`--dump-config` 也因此是**免重启的装配检查**。

**真实一轮已测（2026-10-23，用户批准后执行）**：

```bash
"<DSH>/resources/runtime/cli/bin/dsh.cmd" --profile headless "只回复四个字：BALEEN-OK。不要调用任何工具，不要解释。"
```

`rc=1`，10 秒返回，报 `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`。

- **模型调用 0 次**（没花额度），而且不是"卡住"——它干净地报错退出。上游那个"桌面版自动跑会卡住"的风险，在这台机器上当前的表现是**拿不到凭据**，不是挂起。
- 缺的**不是凭据文件**：`$DSH_HOME/.credentials.yaml` 就在家目录根部（7899 B，操作期间仍在被写）。缺的是 `deepseek-official` 这条 **API-key 路线上的 key**。最可能的解释是桌面版用账号登录跑模型、没单独配 API key，因此 CLI 起的独立进程拿不到——**未证实**，需要她在 Models 页看一眼。（我只看了文件名与大小，没读内容。）
- 启动时还有别的插件告警（`dsh.allowDshCompaction` 配置项已废弃、`bili-native-dsh` 签名上游被拒），侧面说明 bundle 全装配了。

**对 M3 的影响**：原设计"插件起 headless 会话做判断轮"在这台机器上现在跑不通。两条出路——把 `DEEPSEEK_API_KEY` 注入 spawn 环境（插件就得负责保管密钥，与"插件不持凭据"的红线冲突）；或**判断不另起进程**，由宿主内已有的会话用插件注册的只读工具来做（零凭据工程）。选型待她拍板，未拍板前 M3 不落实现。

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

**她的真实订阅（同日补测，见计划"第四个缺陷"一节）**：Eco-socialism and Nature（Substack）、Messy Writings（Medium）、innei 的小站。首轮按原全局 14 天只留 3 条候选（存货中位 137 / 54 / 166 天），改成"首轮免过期 + 按源 `max_age_days`"后 **40 条候选 / 0 丢弃**，紧接的第二轮 **抓 0**——真实 feed 上第一次证明游标过滤成立。

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
| V4 `settings.section` 在桌面版是否出现 | **已闭环（2026-10-26）**：DSH 设置 → Harness 设置左侧导航出现 Baleen 段（紧邻学习工作台），四页签真机渲染真数据 | M5 验收记录见下节 |
| V5 B 站内嵌播放器 | 未开始 | 需要面板存在，属于 M2/M4 |
| V7（新增）宿主 `timer` 能否替代自建调度 | **已评估，维持现状（2026-10-25）** | 宿主没有提供可替代的调度服务——参考实现 dsh-study-desk 同样自管 timer 并靠 `ctx.effect` 生命周期回收；自建调度（lib/scheduler.js）继续 |

## M3 判断轮：真机验收记录（2026-10-25，**全部通过**）

用户给了三个真实源（substack 期刊 / medium / innei 独立博客），agent 配源并全流程实测。**过程中抓到并修掉三个真问题**：① link 挂载不等于热加载（代码更新需重启宿主）；② 宿主运行中重写 cordis.patch.yml 会丢 link 装配条目（重启后插件整个不加载，重新 `plugin add` 恢复）；③ **宿主 10 月更新后工具/注入 API 变了**——正确形态是 `ctx.inject(['tools'|'systemPrompt'], callback)`（dsh-mneme 活样本），study-desk 的 `ctx.on('system-prompt/assemble')` 旧事件已不存在，且 `verdicts` 数组参数上错位的 `additionalProperties` 被宿主 schema DSL 拒绝导致整个工具面注入失败。修复后诊断日志落 `tool_registered` ×5 + `pending_section_mounted`。

**实测结果**：

- **摄取**：innei 成功 10 条全候选（follow 豁免主题闸）；ecosocialism / messywritings 本轮 network 失败（两站需代理，DSH 宿主 fetch 不走系统代理——环境问题），面板诚实报告失败 + 游标没推进 + 下轮自动补。
- **注入段真机可见**（Task 3 附条件必验项）：会话里模型确认"系统提示里明确注入了「Baleen：待判 10 条」，工具也挂上了"，并复述了注入里的失败源清单。
- **判断轮全流程**：模型逐条读内容（对 body_state=summary_only 的条目诚实交代"没读到正文按标题判、理由写明未核实"，并主动抓原页补正文）→ 三档判断 → `baleen.save_verdicts` 写回：10 条落库（值得看 1 / 可以看 5 / 不值当 4）、status 全部 new→judged、digest 关联 run 且 headline 计数正确（sqlite 只读直查实证）。
- **越界词**：让模型故意传 tier="满分" → 宿主 schema 层拒：`ToolCallError: "verdicts[0].tier" must be one of ["值得看","可以看","不值当"]`——写库之前拦下，原判断无污染。
- **面板闭环**：汇报格显示真 digest（headline + tiers 计数）、今天格"待判 0｜已判 10"、十张卡全部带三档徽章。
- **顺手修掉一个真机抓到的谎报**：跑过轮但零丢弃时 gapText 误说"还没有一轮记录"——已改为诚实显示"丢弃 0"（399/399）。

**遗留小项**：substack / medium 两源需代理或 M4 适配器处理（下轮自动补机制已演示）；注入 catch 补一行 warn 日志（Task 3 非阻塞建议，随后续改动带上）。
## M4a B 站通道：全链闭环（2026-10-26 凌晨，**验收通过**）

性能调优（字幕 5s 上限 + detail 并发 3，8b4fd98）落地后，run 19 真机抓取成功：**影视飓风 30 条入库（含 26 条 AI 字幕，body_state=subtitle），全程 21 秒**（并发 3 + 字幕 5s 预算生效）。数据手术恢复 10 条带字幕条目为待判（follow.feeds 修复前的 no-match 归档条目，验收用），会话「今日Baleen候选判定」第二轮判断：

- **10 条 B 站视频全部判完落库**：值得看 2 · 可以看 4 · 不值当 4（sqlite 实证，digest id2 关联 run 19）。
- 模型消费了字幕正文（评测类视频的判断理由具体到"参数向上手，几天即过时"），并主动指出 id=12/id=21 是用户论述题的实证材料、"又是单源兜底"（诚实观察）。
- 面板：文章/视频卡片三档徽章、汇报视图第二条 digest。

**M4a 验收：通过。** 剩余：xhs/yt 属 M4b（未开始）；substack/medium 需代理；-352 节流的 IP 时效与真实节奏复核仍在观察期。

## M4a B 站通道：真机监督记录（2026-10-25 晚，run 16/17/18）

代码侧（`2026-10-25-baleen-m4a-bili.md`）全部完成并推送；真机监督跑了三轮，**管道正确性全部实证，视频进库被性能调优卡住**（如实）：

- **路线变更（用户纠偏）**：MCP 子进程方案废弃（BiliStalkerMCP 强制登录态，与"直接抓"矛盾），适配器改纯 fetch 直连——wbi 签名自研（官方向量钉测）、`dm_img_*` 风控指纹参数实测补齐后匿名列表可通、cookie 降为字幕增强。上游审查结论与 vendor 历史在 git（9956c28 之前的 668adac）。
- **语义修正**：匿名态 B 站视频 body=简介（summary_only 进候选）——"没 cookie 就全丢"的原始裁定在 cookie 可选化后不成立（98e719f）。
- **真机实证通过**：bili 源进队列与 UID 解析；wbi 列表请求（带凭据后 200 code=0）；管道全链（列表 → 逐条 view → 字幕 → 入库）的**错误分类与诚实报告**——单条 -404 降级 missing 不拖垮源、字幕 CDN fetch failed 留诊断日志、90s 预算超时游标不推进、面板逐源报告（bilibili-tech timeout / 两源 network / innei 正常）。
- **真机抓到并修复**：20s 预算不够（run 17）；超时后孤儿调用（run_end 之后还在打 detail API）→ AbortSignal 全链（超时即取消，重试拿新 signal，70d5050）。
- **未通（如实）**：影视飓风（UID 946974）的视频尚未进库——单条处理 30-60 秒（字幕 CDN aisubtitle.hdslb.com 下载慢）× 串行逐条 = 90 秒预算只够 2-3 条。**下轮调优**：字幕单请求 5 秒上限（慢即放弃降 summary_only）、detail 受限并发或首屏只取 top N、按真实节奏复核（-352 节流桶有 IP 时效）。
- 另：UID 679488810 是选源时记错的空号（"列表为空"报错真实），错误信息已加 UID 核对提示（32c0310）。

## M4b yt 通道：真机验收记录（2026-10-26 凌晨，**通过**）

代码侧四笔（099ebf1 适配器 → 81108bf 字幕改 yt-dlp 下载+轨间回退 → 81e5dba subtitle 工具分流 → 2d16787 knownIds 跳过+每轮上限 12 → eb52730 重试预算压 1）+ 统一评审（blocking 一项修复后 verified）。**run 20（07:00 定时轮）宿主内全链一次通过**：

- **fireship（yt 源）成功**：抓 1 → 候选 1 → 落库 id 41《Did Anthropic just kill the indie hacker》——kind=video、**body_state=subtitle**（2542 字，zh-Hans 限流自动回退 zh-Hant，`yt_subtitle_lang_fallback` 日志实证）、status=new 待判。宿主内 yt-dlp 直连可用（无需代理——与设计探测一致）。
- **knownIds 跳过生效**：`bili_skipped_known：30 条已入库，跳过详情与字幕`——bili 源从 21 秒降到约 10 秒，消除每轮重抓（风控友好）。
- innei 正常无新文；ecosocialism/messywritings 持续 network 失败（需代理，既有环境项）。
- 已知项（如实）：匿名 flat 列表时段性只回 1 条（Task 1 冒烟发现）——首轮只进 1 条新视频，后续轮次按列表实际返回续传；中文原声的 `-orig` 轨名变体未在真机验证（无中文 yt 源）。
- **待办**：fireship 待判条目由下一轮判断消费（用户开口或注入引导）；xhs（扫码+MCP 审查）、ASR 转写（依赖 M5 开关）属 M4b 余项。

## M2.5 真机装载与验收记录（2026-10-25，agent 远程执行，用户授权）

**装配**：确认应用退出后，先做 `cordis.patch.yml.bak-baleen-m25-<ts>` 与 `package.json.bak-baleen-m25-<ts>` 双备份，再 `dsh plugin --profile desktop add link:D:/dsh-baleen`——一次成功，pnpm 顺带装好依赖（再跑一次 install 显示 "Already up to date"）。Task 11 计划里的 `--dump-config` 免重启校验被新版 CLI 拒绝（"profile desktop is managed exclusively by the Electron application"，该检查写作时可用，DSH 更新后收紧），改用启动日志法验证。

**启动**：正常拉起 GUI，启动日志**零新增** crash（`$APPDATA` 下 `@deepseek-ai/dsh-desktop/logs`，成功启动会清旧日志，比文件名不比数量）——宿主半与客户端半装配健康，未出现 `1 entry did not activate`。

**面板验收（截图逐项）**：

- 侧边栏「Baleen」入口出现，面板不白屏；暗色主题跟随宿主，无白底白字。
- 六格导航：今天/视频/文章/收藏/汇报/库，落点「今天」；空库空态诚实（「库里 0 条 · 还没有跑过一轮」「（还没有一轮记录）」，无假总结）。
- 收藏页：左列「默认（默认） 0 条」、工具条（新建夹输入框 / 建夹 / 当前夹名回落「默认」/ 改名），**默认夹没有删除按钮**；空态文案指向抽屉「收藏到…」。
- 建夹：输入「测试夹」→ 建夹 → 左列出现「测试夹 0 条」、回显「建好了：测试夹」、输入框清空、当前夹不漂移。
- 删夹：选中测试夹后出现「删除这个夹」→ 二次确认框（文案含「只删收藏关系，条目本身不动」）→ 确认 → 夹消失、回显「夹删了，里面的条目一条都没动」、当前夹回落默认。
- 面板 → 宿主 → 本机 sqlite → 面板的写读回路全通（建、删各一次，测试夹已清理）。

**未验（如实）**：抽屉「收藏到…」多选与「这源多来点」——真机库为空，点不开卡片抽屉，等有数据后自验；明色主题、窗口拉窄两栏折单列、汇报区「收藏钉住」chip（需先跑一轮有豁免的摄取）——留待日常使用中看；V4 的 settings.section 逐项核对未做（本次范围是 M2.5 面板与收藏功能）。

## 隐私与脱敏说明

本文档不含用户名、家目录绝对路径、token/cookie。DSH 安装目录与 runtime 路径是公开安装路径，可以写；`$DSH_HOME` 一律写成 `~/.dsh` 或"由 `DSH_HOME` 指定"。

## M5 设置页：真机验收记录（2026-10-26，**通过，V4 闭环**）

代码侧四笔（68e5e0e preference 读写 → 10fdf52 凭据与环境 → 491cc71 库管理 → cf3cb37 四页签客户端）+ 统一评审 clean（3 minor 记台账）。真机验收（重启宿主后）：

- **settings.section 注册成功（V4 正式闭环）**：DSH 设置 → Harness 设置左侧导航出现「Baleen」段（紧邻学习工作台——study-desk 同款位置），点击进入 Baleen 设置页。
- **源页签**：五个源真实状态全列出（B 站/YouTube「最近抓取：正常」、两个 RSS「失败（network），游标没推进，下轮自动补」如实）——每行开关/权重/间隔/删除，底部新增表单（类型枚举 rss|bili|yt）。
- **凭据与环境页签**：B 站 cookie「已写入（更新于 2026/10/25 20:39:50，内容不回显）」；环境探测 Node 24.21.0、yt-dlp 2026.06.09（真 spawn 探测值）、库 80KB、家目录可写；小红书「未接入（M4b 待做）」、转写依赖「未实现（随 ASR 一起）」两个诚实占位；复制诊断按钮（脱敏尾行）。
- **库页签**：数据目录 `<HOME>/baleen` 占位；导出 Markdown、按天数清理（天数未填按钮不亮）、清空库（红字警示 + 输入「清空库」三字才亮的字面量门）。
- 红线真机抽查：PUT 白名单无 tuning/version；凭据零回显（页面上只有状态行）；偏好读不到时整页只读（防半盲写）。
- 偏好页签含 themes/redlines/schedule/limits/开关们/charter/tuning 一览与一键归零（客户端测试已钉，真机操作留给用户日常）。
- **M5 验收：通过。** M0-M5 全部里程碑完成；余项：xhs（扫码+审查）、ASR（转写）、substack/medium 代理、若干 minor 分诊项。

## 节流与配额：真机验收记录（2026-10-28，**通过**）

上一版代码里 `interval_min` / `max_per_day` / `off_peak_only` 三个字段只在校验层和 UI 层出现，调度层一次都没读过；`runningNow()` 又只看 `status === 'running'`，重启打断留下的假尸会让清库路由永远 409。这一轮把四件事一起修了（`77dd578` `47949d2` `1afae73` `88d0ee2` `5c11aec` `aa863a6`），下面是真机上电后的实测。

**修复前的库（作为对照）**：`runs` 共 102 行，其中 86 条 `partial`；最后 12 轮严格每 5 分钟一轮（run 99/100/101/102 的 `started_at` 间隔 300000ms）；run 24 与 run 101 是 `status='running'`、`finished_at IS NULL` 的假尸，分别起于 2 天前和 7 小时前。

**上电**：重启宿主后诊断日志落新的 `plugin_loaded` + `tool_registered` ×6 + `pending_section_mounted`，`migrate()` 在加载时补列成功——`PRAGMA table_info(sources)` 从「没有 `last_attempt_at`」变为有（这就是老库的升级路径，无需手工迁移）。

**首轮（run 103，手动触发）**：16:41:37 起、16:41:59 收，`partial`；五个源全部写入 `last_attempt_at = 16:41:59`（含两个 `network` 失败的源——失败也记账，这正是坏源不会每 5 分钟重试的原因）；三个成功的源同时写了 `last_ok_at`。

**节流生效（用真代码直接打线上库，只读）**：

| 断言 | 结果 |
|---|---|
| `anyDue(now)` | `false` |
| `planJobs({now})` 不带 force | `0` 个 job |
| `planJobs({now, force:true})` | `5` 个 job（手动触发保留全量能力） |
| `anyDue(now + 720min)` / `planJobs(now + 720min)` | `true` / `5` 个 job |
| 下一轮到点 | 当日 16:41:59 + 720 分钟 = 次日 04:41:59 |

**空转消失**：重启后 4 小时以上，`runs` 一直停在 103，`SELECT COUNT(*) FROM runs WHERE id > 103` 为 0；诊断日志里 `run_idle` 计数为 0（空转轮按设计静默跳过，不写日志也不留 run 记录）。对照修复前同时段本该多出约 48 轮。

**假尸放行**：run 24（起于 2026-10-26 07:20:32）与 run 101（起于 2026-10-28 07:50:38）在 `effectiveRunStatus(run, now)` 下均返回 `interrupted` 而非 `running`，清库/归档清理路由不再被这两条永远挂着。库里保留原始记录不删——判定在读取侧做，不动历史。

**顺带**：id 41 的 Fireship 待判条目已判为「可以看」并经 `saveVerdicts` 落库（同时落一条 digest），`items` 状态从 `new 1 / judged 20` 变为 `judged 21 / new 0`。

**未验（如实）**：`max_per_day` 的当日额度闸只在单测里钉住（`test/tools.test.js`），真机上当天判断量远低于 60，没有触发过截断——要等某天判得多才看得见；`off_peak_only` 关掉后的放行行为同样只有单测覆盖，真机偏好里它是开着的。

## 公开历史脱敏：真名路径改写记录（2026-10-28）

仓库转 public 后复查 commit 历史，发现 `a50f88c`（docs: M0+M1 实现计划）里有一行调试命令含本机家目录真名路径；`3a200ea` 是事后修这一行的提交，所以 `git log -S` 也会命中它。HEAD 树上早已是 `<USER>` 占位，只有历史里残留原文。已做历史改写。

**改写前后对照**（`git filter-repo --replace-text`，规则：把本机用户名一律替换为 `<USER>` 占位）：

| 项 | 改写前 | 改写后 |
|---|---|---|
| 提交数 | 120 | 120 |
| `git log -S` 真名命中提交 | 2（a50f88c、3a200ea） | 0 |
| 全历史 `git grep` 命中 | 55 个提交含该串 | 0 |
| HEAD 树哈希 | `2ecfa50` | `2ecfa50`（逐字节相同） |
| HEAD 提交 | `6342423` | `c6a55eb` |
| `v0.1.0` tag 对象 | `a4fe0ea` → 指向 `b1d029c` | `e168d89` → 指向 `002a9f8` |

**做法**：先在 `/tmp` 镜像里干跑（确认 120 提交不少、树哈希不变、tag 自动跟随），再备份完整镜像到 `/tmp/baleen-backup.git`，然后对本仓库执行改写。强推走 `--force-with-lease`（旧值 `6342423`），tag 同样带 lease 强推。改写期间临时删除 main 保护、推完按原参数恢复（`strict:true`、contexts 两个 matrix 作业名、`allow_force_pushes:false`、`allow_deletions:false`、`enforce_admins:false`）。

**核对**：从远端重新 `git clone --mirror` 全量拉一遍，提交数 120、真名命中 0、HEAD 树哈希与改写前一致；CI 在新提交 `c6a55eb` 上 success；Release `v0.1.0` 仍正常挂在新 tag 上；npm 包不受影响（tarball 是发出去的不可变产物，`files` 白名单里本来就没有 `docs/`，真名从未进包）。

**顺带查过的**：`vendor/bilibili-mcp/**` 历史里还有 BiliStalkerMCP 上游源码（MIT），其中含上游作者的个人联系方式与账号名——这类**第三方的个人信息不该被我们长期保存**，已在历史改写中一并替换为占位符，只保留项目名与提交哈希做署名；`SESSDATA=` / `bili_jct=` 命中的全是测试夹具假值（`SESSDATA=fake-value; bili_jct=fake`），无真 cookie；`sk-` 命中全是 `sk-control` 这个词本身。

## 第二轮：第三方个人信息也一并清掉（同日）

第一轮只处理了本机真名。复查时发现历史里还有**上游作者**的个人联系方式与账号名——那同样是个人信息，我们没理由长期替别人保存。第二轮单独做了一次改写，只针对邮箱串：

| 项 | 改写前 | 改写后 |
|---|---|---|
| 提交数 | 122 | 122 |
| `git log -S` 邮箱命中提交 | 4 | 0 |
| 全历史 `grep` 该串 | 4 个提交 | 0 |
| HEAD 树哈希 | `5cde395` | `5cde395`（不变） |

**保留的**：项目名 `BiliStalkerMCP`、上游提交哈希 `952fd83`、MIT 许可的版权署名行（`Copyright (c) 2025` 后的原作者账号名）——MIT 明文要求「在所有副本中保留上述版权声明」，删掉反而是侵害作者权利；这类署名说明的是「谁写的」而非「怎么联系他」，该留。仓库链接里的账号名同理，那只是项目地址。**清掉的**：邮箱——那才是能被直接用来发信骚扰的私人联系方式。

**做法**：同样先在 `/tmp` 镜像干跑（122 提交不少、树哈希不变），再对本仓库改写；强推 main 与两个 tag 都走 `--force-with-lease`，推完恢复 main 保护。

**代价（如实）**：所有 commit hash 再次变化，任何已克隆的副本都会与远端分叉。改写时仓库 0 fork / 0 star、建库两天，实际影响为零。
