# M4b 计划：yt 适配器（YouTube 通道）

> 范围裁定（2026-10-26 凌晨，用户"继续跑"授权）：M4b 三件里 **yt 本任务做**；**xhs 阻塞**（扫码登录需用户在场——等她醒来再启动，含第三方 MCP 选型审查）；**ASR 转写依赖 M5 的设置开关**（spec §9"装转写依赖（默认关）"），M5 时一并做。本计划只覆盖 yt。

**Spec 依据：** 主设计 §3.1（yt 依赖 `yt-dlp`，覆盖"YouTube 元数据与字幕"）、适配器三红线（不判断/不写库/重试≤1）、§6.2 错误表、body_state 六值。

**本机实测（2026-10-26 凌晨，设计依据）：**
- `yt-dlp` 2026.06.09 在 PATH（`D:/Miniconda/Scripts/yt-dlp`）。
- **不走代理直连可用**（频道 flat-playlist 与单视频 dump 均通）——TUN 模式或网络本身可达；宿主内 spawn 子进程的网络行为与 shell 相同（子进程独立走系统网络），预期宿主内也可用（待真机验证）。
- 频道列表：`yt-dlp --dump-single-json --flat-playlist --playlist-items 30 <channel>/videos` → `entries[]`（id/title）。
- 单视频：`--dump-single-json <watch_url>` → duration/upload_date/subtitles（manual 按语言）/automatic_captions（zh-Hans、en 等，每条带 url+ext=json3|vtt）/description/thumbnail。
- 字幕轨 URL 直接 fetch（json3 是 YouTube API 形态，无需登录）。

## Task 1: `lib/adapters/yt.js` + 测试

- **源配置**：`type: yt`，url 为频道 `/videos`、playlist 或单视频 URL。
- **流程**：flat-playlist 一次（30 条）→ 增量条目逐个 dump-single-json（**并发 3 保序**，照抄 bili 的 mapLimit）→ 字幕轨选取与下载（**5 秒预算**，照抄 bili 的 AbortSignal.any 模式）→ RawItem。
- **字幕优先级**：manual zh-Hans/zh-Hant/zh > manual en > auto zh-Hans > auto en；格式 json3 优先（json 解析 events[].segs[].utf8），vtt 兜底（去时间轴/标签的极简解析器）。**body_state 语义**：拿到任何字幕轨文本 = `subtitle`（auto captions 虽是平台 ASR，但形态就是字幕轨，与 bili 的 AI 字幕同待遇）；无字幕但 description 非空 = `summary_only`；都空 = `missing`。
- **RawItem**：external_id=视频 id、kind='video'、url=watch URL、duration_sec、published_at（upload_date YYYYMMDD→ms）、thumb=thumbnail、body=description+字幕。
- **yt-dlp 解析**：preference 可选键 `yt_dlp_path`（缺省 'yt-dlp' 走 PATH）；二进制不存在/spawn ENOENT → error_class `unavailable`（spec §6.2"缺依赖"）。preference 可选键 `network.proxy`（缺省空；设置后传 `--proxy <value>` 给 yt-dlp——宿主无代理环境时的逃生门，只作用于 yt-dlp 参数，不改全局 fetch）。
- **预算与取消**：job `timeout_ms: 90000`（同 bili）；pool 的 abort signal 接到 spawn（abort 时 child.kill）与字幕 fetch；子进程本身 60s 硬超时（防 yt-dlp 挂死）。
- **零重试**；错误映射：spawn ENOENT→unavailable、非零退出→parse（stdout 尾行进 detail 截断 120 字）、abort→上抛、字幕下载失败→单条降级 summary_only + 诊断一行。
- **测试**（注入 spawnImpl + fetchImpl，桩手法照 test/adapters-bili.test.js）：flat-playlist 解析、单视频翻译（duration/upload_date/thumb）、字幕优先级（manual-zh > manual-en > auto-zh > auto-en）、json3 与 vtt 解析器、无字幕→summary_only、都空→missing、ENOENT→unavailable、abort 杀子进程、并发 3 保序、--proxy 传参（key 设置时）、已有 KNOWN_TYPES 登记 yt。
- **真机冒烟**（实现者做，shell 直连已验证可用）：真实频道跑一次 flat+2 条视频 dump+字幕下载（临时脚本，用完删）。

## Task 2: 面板与工具的 yt 形态

- `baleen.subtitle` 对 yt 条目：库里已存字幕全文直回（与 bili 同路径，本任务大概率零改动——核实即可）。
- 预览夹具/视图：kind=video 已通用（M4a Task 4 核过），零改动预期；仅在抽屉对 yt URL 的展示上核实无 YouTube 特有假设。
- verification.md 冒烟记录。

## 不做（本计划）

- xhs（阻塞在用户扫码 + MCP 选型审查，单独计划）。
- ASR 转写（等 M5 开关；dsh-bili-scroll 的 asr.py 是现成参照：yt-dlp 下音频 + whisper + hf-mirror）。
- YouTube 登录态（cookie 越来越常见，但 v1 直连够用；需要时按 bili-cookie.txt 同款加 credentials/yt-cookie.txt + `--cookies` 参数，接口留好：`network.yt_cookie` 键位预留不做）。
- 平台写操作（红线，永远）。

## 验收判据

1. 全量测试绿；2. 真机宿主内 yt 源跑一轮：视频入库（字幕/summary_only/missing 三态如实）、面板视频卡显示、判断轮可判；3. yt-dlp 缺失时的 unavailable 降级路径有测试；4. 零新增 npm 依赖。
