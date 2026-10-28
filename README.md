# Baleen（`dsh-baleen`）

> 每天替你过一遍信息源：灌进一整轮内容，**读正文和字幕**（不是读标题）留下值得看的，把水和标题党排掉，然后把这一轮的判断写成图文汇报放在你面前。
>
> 名字来自鲸须——须鲸的滤食结构。这个产品做的同一件事。

**当前状态：M0–M5 全部完成并已装载进 DSH 真机验收。** 摄取（RSS / B 站 / YouTube 三通道，读正文与字幕）→ 本地预筛 → 面板六格导航与收藏页 → 判断轮（五个只读工具 + 唯一写工具 save_verdicts，三档枚举锁死）→ 每轮增量汇报 → 设置页四页签，全链路真机跑过。小红书通道未做（需先做代码审查）。

## 看面板长什么样（不装 DSH、不联网）

```bash
npm install
node tools/preview.mjs      # 出 out/preview-*.html，每页明暗两块
open out/preview-today.html # 浏览器直接打开即可
```

预览调的就是 `src/client/views/` 里那批真渲染函数，所以它不是另画一套。两处对不上真机：真 React 的节点形状、以及宿主真实调色板（预览里的 `--dsw-alias-*` 是按观感近似的**替身值**，页面顶部有标注）。

## 现在就能试

```bash
npm install            # 唯一依赖：yaml（纯 JS，无 install 脚本）
npm test               # 573 个测试，node --test，不需要网络
cp preference.example.yaml ~/baleen-trial/preference.yaml   # 先自己建目录
BALEEN_HOME=~/baleen-trial node tools/live-ingest.mjs --reset   # 真抓一轮公开 feed
```

`tools/live-ingest.mjs` 不经 DSH、用假宿主上下文直接跑一轮，`BALEEN_HOME` 指到临时目录就不会碰你真实的 `~/.dsh/baleen`。

## 设计原则（改代码前先读这几条）

- **只读世界**：不注册任何平台写操作。没有评论、私信、点赞、关注、发布——不是"暂时没做"，是产品红线。
- **理由必须可信**：每条候选都带"为什么给你"。关键词匹配因此对英文走词边界、对中文走子串——子串匹配曾经把 "building" 判成命中 `UI`，那种假理由比没有理由更糟。**你写关键词时大小写是语义**：`React` / `CSS` / `MCP` 这类含大写的按大小写敏感匹配（散文里的 "how we react to" 不算命中框架），全小写的 `agent` 则不敏感。
- **读不到要可见**：`body_state` 分 `full / summary_only / subtitle / transcribed / missing / burned_in` 六档；`missing`（没有语音）和 `burned_in`（字烧在画面上）是两回事，汇报里"因无字幕跳过 N 条"必须写出来。
- **失败不推进游标**：抓取失败的源保留旧游标，下一轮自动补缺口。内容只会推迟，不会永久丢。
- **首轮收存货**：某个源还没有游标时不看发布日期——低频作者的 feed 里全是几个月的旧文，而刚订阅的你没读过，那正是首轮最值钱的部分。之后才用 `max_age_days`，且**可以按源覆盖**（慢更源 365 天，高频源 14 天）。
- **成本三道闸**：本地预筛在前 → `max_per_run` → `max_per_day`；工具失败两次就记跳过，不许反复重跑。
- **默认按偏好过滤**：`require_theme_hit: true` 时，没命中任何主题且不是关注 feed 的内容不进候选。关掉它就退回"启用一个源=它全部内容都进候选"。

完整约束见 [AGENTS.md](AGENTS.md)，设计见 [docs/superpowers/specs/2026-10-23-baleen-design.md](docs/superpowers/specs/2026-10-23-baleen-design.md)，实测记录见 [docs/verification.md](docs/verification.md)。

## 数据放在哪

插件运行后全部落在自己的家目录（默认 `~/.dsh/baleen/`，本机因 junction 实际在 D 盘；可用 `DSH_HOME` 或 `BALEEN_HOME` 覆盖）：

```
preference.yaml     你编辑的偏好真源（themes / follow / sources / tuning）
baleen.sqlite       条目库（items / sources / runs / digests / meta）
out/                每轮汇报的 Markdown 副本
logs/diagnostics.jsonl   脱敏后的运行日志
run.lock            单实例锁（带 pid，进程被强杀后陈旧锁会被自动接管）
```

不上传、不遥测。凭据只落这个目录（`credentials/`，B 站 cookie 用 `chmod 600` 保护，从不进仓库、不进日志），偏好里的 `themes` / `follow` 只在本机。

## 代码地图

| 文件 | 责任 |
|---|---|
| `index.js` | 宿主半入口：装配、`/api/dsh-baleen` 只读路由、服务注册、调度启动 |
| `lib/adapters/rss.js` | RSS/Atom 适配器；失败时抛 `status` / `empty` 供上层分类 |
| `lib/adapters/bili.js` `lib/adapters/bili-wbi.js` | B 站：纯 fetch 直连 + 自研 wbi 签名 + 风控指纹；字幕走 player/wbi/v2 |
| `lib/adapters/yt.js` `lib/adapters/yt-captions.js` | YouTube：yt-dlp 直连取列表与字幕轨（轨间回退），已入库的 external_id 跳过重抓 |
| `lib/feed.js` | RSS2 + Atom 容错解析（CDATA、坏日期、双重转义、时长三种写法） |
| `lib/pool.js` | 并发 4、单 job 超时 20s、**重试固定 1 次**、错误分类 |
| `lib/normalize.js` | RawItem → items 行：`kind` / `body_state` / 命中理由与得分 |
| `lib/dedup.js` | 入库唯一入口 `putDraft`：insert / update / skip_seen / duplicate |
| `lib/prefilter.js` | 本地闸门与 `summarizeGaps`（丢弃统计） |
| `lib/jobs.js` `lib/runner.js` | 计划与编排，游标只成功才写回 |
| `lib/scheduler.js` | 时段窗（含跨零点）、文件锁单实例、`triggerNow` |
| `lib/preference.js` | 偏好读取、逐字段校验、`bumpTuning` 只写 tuning |
| `lib/diag.js` | 脱敏（家目录、盘符路径、凭据值）与 jsonl 日志 |

## 还没做

- 小红书通道（扫码 MCP 方案，需先做代码审查）
- 汇报的图文排版（当前是 Markdown，图片位留白）

## 名字提示

"Baleen" 在 NLP 圈已有同名 RSS 摄取项目（DistrictDataLabs/baleen 等），带 `dsh-` 前缀才是这个插件。

## 许可

MIT。设计参考与第三方组件署名见后续 `NOTICE.md`（M4 vendor 时补）。
