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

## 宿主侧栏浏览器：能不能给 Baleen 用（2026-10-28，探通，附一条硬门槛）

抽屉里那句「跳到浏览器里看」要兑现，先得知道宿主那台侧栏浏览器能不能被插件调用。结论：**能，而且 B 站完整播放页真的在里面放出来了**——但有个硬门槛（登录态不跨重启），所以只能当"试看窗口"，不能当主力播放器。

### 插件侧的入口（asar 静态取证 + 真机验证）

- 页签控制器在客户端根上下文里：`ctx.sidebarRight.openTab(kind, options)`，浏览器页签的 kind 是 `'browser'`，参数形状 `{ params: { url } }`；URL 与地址栏输入走同一套校验。
- 探测页签在不在：`ctx.get('sidebarRightTabs')?.get('browser') !== undefined`。
- 宿主自己就是这么干的——聊天里的链接在侧栏打开那条路（`openExternalLink`）用的正是 `ctx.sidebarRight.openTab("browser", { params: { url } })`。所以这不是给插件留的后门，是公开入口。

### 真机实测（右侧栏「＋」→ 浏览器页签，Ctrl+T）

| 地址 | 结果 |
|---|---|
| `player.bilibili.com/player.html?bvid=…` | 只出 B 站的空态占位页，播放器壳没渲染 |
| `www.bilibili.com/video/BV…` | 完整播放页加载成功，标题/播放数/弹幕数/互动数据齐全，**画面真实渲染** |

也就是说没有 `X-Frame-Options` / CSP 拦着——挡路的是登录，不是嵌入。

### 硬门槛：每次启动都是全新分区（登录态清零）

宿主实现（`DesktopBrowserGuests`）里，分区名是 `dsh-sidebar-browser-` 前缀拼一个随机 UUID，然后 `session.fromPartition(partition)`。**没有 `persist:` 前缀**——每次启动一个随机新分区；进程内同一 workspace 复用（同一次运行里 cookie 留得住），重启即清。实测印证：视频能播，约 30 秒后 B 站自动弹登录浮层。

那层会话还有硬边界（`configureSession`）：权限请求一律 `callback(false)`、`will-download` 全部 `preventDefault()`、只放行 http/https/ws/wss（且拒带凭据的 URL 与宿主自身 origin）、webview 强制 `sandbox:true / contextIsolation:true / nodeIntegration:false`、不发 referrer。所以它是个"只读的陌生人窗口"，不是第二个登录态浏览器。

### 因此 Baleen 的接法（档 A 已落地）

两条路都摆出来，不替用户选：

| 打开方式 | 登录态 | 适合 |
|---|---|---|
| 宿主侧栏 Browser | 每次重启清零 | 快速看一眼封面 / 前 30 秒 |
| 系统浏览器（`window.open`） | 用户自己已登录 | 真要看完整视频 |

装配层的三条规矩（`test/client-boot.test.js` 有钉子）：

1. **不往 `inject` 里加 `sidebarRight`**——加了而宿主没提供，整个面板都不注册（比少一颗按钮严重得多）。照 `ds-bot` 的写法运行时探测 + `try/catch`。
2. 探不到浏览器页签时**不传那个回调**，抽屉只摆一颗「浏览器打开」，并明说「侧栏浏览器这次没开起来（宿主的浏览器页签不在）」，不摆一颗点了没用的按钮。
3. 侧栏打开失败（宿主版本没有这个 API）**退回系统浏览器**，不静默失败。

**未验（如实）**：① 本机 desktop profile 的 `dsh.profile.bundles` 49 项里看不到 `ui-sidebar-browser`，但页签真机确实存在（bundles 列的是包名，装配路径不止一条）；Web profile 下该包默认关闭，Web 端这条路要额外开。② 档 A 的两颗按钮目前只有单测与预览门覆盖，**还没在真机上点过**。（2026-10-31 已真机点过：双双哑火，见下文。）

## 抽屉两颗打开按钮真机验收：双双哑火，根因两条（2026-10-31）

销 2026-10-28 条目的未验②。前置：DSH 于 10-30 12:00 重启过，`dsh-baleen: link:D:/dsh-baleen` 挂在 desktop profile 的 `package.json`（`cordis.patch.yml` 里只剩 placement 条目——装配条目以 profile `package.json` 为准，本轮实测它没丢），运行代码即工作副本 v0.1.1；库 43 条，fireship 抽屉带真 URL 与真封面。

**测法**：桌面自动化真点（坐标 event click；UIA AXPress 通道在独立窗口上频繁 `surface_replaced`，只作辅助），然后把 DevTools 停靠进主窗口，在 `dsh-app://app/` 页面的 console 里直探同一段调用。

### 结果

| 按钮 | 现象 | console 实证 |
|---|---|---|
| 浏览器打开 | 点击命中（按钮获焦），Chrome 零进程，无任何反应 | `window.open('https://…','_blank','noopener,noreferrer')` 返回 `null`，宿主 deny 弹窗且**不调** `shell.openExternal` |
| 侧栏打开 | 同上，无任何反应 | `sidebarRight.openTab('browser',{params:{url}})` 抛 `sidebarRight: no session surface is mounted`；随后按设计回退到 window.open，被同一条路吞掉 |

同抽屉的「关闭」按钮点击通路完好，排除"面板点击没接上"的可能；console 历史里也没有任何 baleen 侧的异常——两条失败路径都是**静默**的，正是 10-28 担心的那种。

**反事实对照**：切一个聊天会话回主区（会话挂载）后，在同一个 console 里调同一个 `openTab`，成功——右栏弹出浏览器页签，YouTube 完整播放页真实渲染（频道、订阅数、点赞数、弹幕齐全，视频可放），与 10-28 的探通结论互证。

### 根因

1. **侧栏打开**：宿主 `SidebarRightController.require()` 要求"当前有会话挂载"，否则抛上句。Baleen 面板占据主区时**永远没有会话在屏**——从面板抽屉里这个调用注定失败，与宿主版本无关。
2. **浏览器打开**：客户端页面（`dsh-app://app/`，主窗口里的 webview 客体，`webviewTag: primary`）的弹窗走客体管理器，静默 deny。asar 里带 `openExternal` 的 `setWindowOpenHandler` / `will-navigate` handler 属于别的窗口路径（内嵌充值页的 WebContentsView、带 webviewTag 的主窗口模板），对这个客体不生效。默认浏览器（Chrome）因此永远不会被拉起。

两处与代码注释假设不符：

- `_footer.txt` 注释赌「弹窗被拦：链接本身还点得开」——`will-navigate → openExternal` 那条路不在本客体上，原文 `<a>` 在客体里点了去哪**本次未验**（不敢拿真机页面试 `location` 跳转）。
- `hasSidebarBrowser()` 探 `sidebarRightTabs` 里有没有 `'browser'`——实测这个键与 openTab 成败**无关**（键缺失时按钮照渲染；成功开页后键才出现），它预测不了"会话挂载"这个真正的门槛。

### 修复方向（待拍板，先记不先动）

- 侧栏打开：面板态下宿主侧无解。短期现实做法是探测不到"会话挂载"就不摆这颗按钮——但 `hasSidebarBrowser()` 现有探法测不出这个状态，得另找探针或干脆只留一颗按钮。
- 浏览器打开：需要一条不经过 `window.open` 的出口。宿主若有开放的外链 IPC 就走它；没有的话桌面端这颗按钮只能先撤，留 `<a>` 链接（前提是 `<a>` 路径验通）。

### 附带观察

- 抽屉滚到底后数秒内会弹回顶部（疑似面板轮询重渲染导致抽屉重挂载、scrollTop 清零）。不影响本次结论，但长文抽屉的阅读会被打断，值得单开一条修。（同日已修：DevTools 探针实证**不是**重挂载——同节点、scrollHeight 恒定、scrollTop 归零，且面板自身无定时器，唯一执行源是重渲染；对策为渲染期捕捉提交前位置、提交后回填，`scrollMemoNext` / `scrollRestoreTarget` 两个纯函数由单测钉住。）
- UIA 元素动作通道（AXPress / `performSecondaryAction`）在本宿主上大面积 `surface_replaced`，坐标 event click 始终可靠——只影响自动化，不影响人手。

**清理（如实）**：DevTools 已关（停靠后关闭）；实验开的两个侧栏浏览器页签已关；主区停在 Amarre 会话（验收前停在「查看仓库议题533…」，需要自己切回）；Amarre / Mentor 会话只是被切到过，没发过一个字。

### 补：原文 <a> 链接同验（同日稍晚）

上一节留的未验当场补掉。抽屉里那条 `<a class="bl-url" target="_blank" rel="noopener noreferrer">` 用 DevTools console 程序化点击（等价用户真点）：**同样无声无息**——页面不导航、Chrome 零进程、console 无报错。`target="_blank"` 走的正是 window-open 同一条路（客人 webview 的弹窗处理），与「浏览器打开」按钮殊途同归。`_footer.txt` 里"弹窗被拦：链接本身还点得开"的假设在本宿主上不成立。

至此抽屉的三条外部出路——侧栏打开、浏览器打开、原文链接——在当前宿主上**全部静默失效**。"只留链接"的处置选项随之作废，剩下的路：撤掉假动作换诚实的纯文本地址、或给宿主侧加一条只放行库内 URL 的 open-external 路由（真修，需拍板）。

**未验（如实）**：同页导航（`location.href`）那条路没敢在真机上试——两种宿主窗口变体的 will-navigate 都会拦，但拦不住时整个客户端页面会被 YouTube 顶掉，代价不对等。

### 处置落地（同日，拍板选了真修）

- **宿主侧**：新增 `POST /api/dsh-baleen/open`。安全契约：面板只报 `item_id`，URL 由宿主从 `items` 表查——不接受调用方传地址；scheme 白名单 http/https 且拒带凭据的 URL（对齐宿主自己 openExternal 的守卫）；opener 走 `createRequire('electron')` 惰性解析，纯 Node 环境如实 500 `open_unavailable`。opener 可注入，三条拒绝路径与 opener 抛错各有单测（`host-surface.test.js`）。
- **面板侧**：「浏览器打开」改走该路由（成功静默——浏览器自己会弹到前头；失败回显"宿主没能拉起系统浏览器，直接复制上面的地址吧"）；「侧栏打开」撤除（宿主开侧栏页签要求"有会话在前台"，面板在前台时永远不满足），按规矩留了一行说明；`<a>` 链接保留（URL 语义、右键复制仍可用，且在带 openExternal handler 的宿主变体上可点）。
- **未验（如实）**：改动进了 `client.js` 与 `index.js`，link 挂载不等于热加载——**真机验收待重启 DSH 后点一次「浏览器打开」**，预期默认浏览器弹出该条目页；opener 在宿主主进程里能不能经 `createRequire('electron')` 拿到 `shell`，也只有重启后才见分晓（拿不到会是 500 open_unavailable + 回显，不会静默）。

### 第一轮真机验收（同日重启后）：路由链路对，opener 缺席——加兜底

重启（11:26）后点「浏览器打开」：按钮命中、`item#1` 查库成功，但诊断日志记下 `open_external_failed | item#1: opener 缺席`——**插件进程里 `createRequire('electron')` 解析不到**（宿主把插件跑在什么进程形态里未取证，反正 electron 不可达），路由如实 500。同场加测还发现：**本机 Chrome 根本没装**（https 的 UserChoice 指向残留的 ChromeHTML ProgId），但系统级 ShellExecute 是通的——`Start-Process 'https://…'` 直接拉起 msedge，说明关联有兜底。

处置：`resolveOpenExternal` 改成三级解析链——① 注入；② Electron `shell.openExternal`；③ Windows 兜底 `rundll32 url.dll,FileProtocolHandler`（走同一条 ShellExecute 路，`spawn` 精确复刻本机实证可拉起 Edge；exit code 不可靠，只当"发得出去"）。`config.openExternal` 语义收紧为 `hasOwn`：显式 `null` = 明确没有出口（"缺席"单测改走这条，不然 win32 测试真会去拉浏览器）。提交 `7f1d892`。

**未验（如实）**：兜底在**宿主进程里**的实际表现待二次重启后验收——预计 electron 仍不可达（诊断会记一条 `open_external_opener` 的退回理由），随后 rundll32 接管，点「浏览器打开」应看到默认浏览器弹出条目页。

### 第二轮真机验收（同日二次重启后）：通过 ✅

二次重启（15:40）后从库视图点「十月未央」抽屉的「浏览器打开」，三重证据：

1. 诊断日志按预期先记 `open_external_opener | electron 不可用（MODULE_NOT_FOUND），退回系统 rundll32`，再记 `open_external | item#1 → innei.in`——解析链降级与成功分支各就各位；
2. 无任何失败回显（成功按设计静默）；
3. **Edge 弹出窗口，标题 `十月未央 - Innei - 个人 - Microsoft Edge`**——条目页真实打开。

全链路：按钮 → POST `/open`（面板只报 id）→ 宿主查库 → opener 链（electron MODULE_NOT_FOUND → rundll32）→ ShellExecute → 默认浏览器。「浏览器打开」自此是活的；侧栏那条按"撤除 + 说明"处置完毕。验收过程不影响同时段在跑的宿主会话任务。

