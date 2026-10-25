# M4a 计划：B 站通道（bili 适配器全链）

> 范围裁定：M4 拆两半——**M4a 只做 bili 全链**（vendor → 适配器 → subtitle 工具 → 真机验收），yt（本机有 yt-dlp 但宿主无代理，诚实降级）与 xhs（需扫码 + 第三方审查）放 M4b。用户授权"继续吧"，M4 拆分与选型取推荐项（BiliStalkerMCP），可随时改。

**Spec 依据：** 主设计 §3.1（bili = vendored bilibili-mcp 子进程，stdio JSON-RPC，MIT；适配器不判断/不写库/重试≤1）、§6.2（B 站风控 412 → 退避重试 1 次 failed、字幕空 → missing 丢弃、burned_in 保留标注）、§10.1（baleen.subtitle 工具，M4 起）、body_state 六值（subtitle/transcribed/missing/burned_in 在 M4 分化）。

**前置审查（已通过）：** BiliStalkerMCP @ 952fd83（v3.6.0.dev0，MIT）——approve with conditions。四条条件：① GPL 依赖（bilibili-api-python，上游因 B 站法律函关停）运行时装、锁 `==17.4.2`，绝不进 Baleen 仓库；② vendor 内部重试（默认 3）视作 Baleen 的那 1 次，适配器层零重试；③ 登录态硬依赖——SESSDATA 等放 `credentials/bili-cookie.txt`（纯 Cookie 头格式）经 env `BILI_COOKIE_FILE` 注入，凭据目录只读消费；④ `BILI_ENABLE_COOKIE_REFRESH` 不设（禁用自动回写凭据）。安全面干净：外联仅 bilibili 域、无写操作工具、无 eval/exec、日志脱敏。

## Task 1: vendor 与运行时

- `vendor/bilibili-mcp/`：上游 `bili_stalker_mcp/` 源码 + `pyproject.toml` + `uv.lock` + LICENSE 副本 + `VENDOR-NOTES.md`（commit 952fd83、四条条件、补丁清单）。
- vendor 补丁（两处小改，VENDOR-NOTES 记录）：`VideoListItem` 加 `pic` 封面字段映射；`max_retries` 默认 3 → 1。
- 运行时：`conda create -n baleen-bili python=3.12` → `pip install -e vendor/bilibili-mcp`；启动命令 `<python312>\python.exe -m bili_stalker_mcp serve`（stdio）。
- `git check-ignore` 确认 credentials/ 与 vendor 的 Python 产物（.venv 等）不进仓库。
- 提交：`feat: vendor bilibili-mcp（BiliStalkerMCP @952fd83，MIT，四条审查条件落地）`

## Task 2: bili 适配器（lib/adapters/bili.js）

- 源配置形态：`type: bili`，url 填 UP 主 space URL（解析出 UID）。
- 流程：spawn 子进程（stdio JSON-RPC，按需起用完收）→ `get_user_videos(uid, 1, 30)` 取列表 → 与库比对（external_id = bvid）得增量 → 增量视频 `get_video_detail(bvid, fetch_subtitles=true, subtitle_mode="smart")`。
- RawItem 翻译：title/duration_sec/published_at（created_time）/body_text=简介 + 字幕全文（有字幕 → `body_state=subtitle`；字幕空/无 → missing → 预筛丢弃；burned_in 由既有预筛标注逻辑承接）；thumb=pic 补丁字段。
- 错误映射：vendor 结构化错误（code=412/429/403、need_login）→ error_class；`need_login_subtitle` → 该条 missing 处理 + 诊断日志一行"B 站字幕需要登录态"。凭据文件缺失 → 源级 failed，错误信息指向 credentials/bili-cookie.txt。
- 红线：适配器零重试（vendor 内部重试即 1 次预算）、不判断不写库。
- 测试：假子进程桩（JSON-RPC 帧编解码、增量比对、body_state 三态、凭据缺失降级、412 映射）。**真网络冒烟单独跑**（tools/live-ingest 手法）。

## Task 3: `baleen.subtitle` 工具（第六个）

- 读参数 `{id}`，条目 kind=video 且 body_state ∈ {subtitle, burned_in, missing} 时现取字幕（同 Task 2 的 detail 调用），返回全文；只读。
- **工具面从五个变六个**：AGENTS.md 第 12 条、test/tools.test.js 清单断言、spec §10.1 已列——三处同步。
- 提交：`feat: bili 适配器与 baleen.subtitle（第六个工具，字幕只读）`

## Task 4: 面板半

- 视频/今天/库/收藏视图对 kind=video 的展示（时长 fmtDuration 已有、thumb 已有）；抽屉对 bili 条目显示 URL + 时长 + 字幕状态（内嵌播放器 V5 另评估——桌面 app 里 iframe 的可行性先探再定，不阻塞 M4a）。
- 预览夹具加一条 bili 视频条目（duration/subtitle 态）。
- 提交：`feat: 面板与抽屉的 B 站条目形态`

## Task 5: 真机验收（**需要用户先提供 B 站 cookie**）

- 凭据：用户从浏览器复制 B 站 cookie（SESSDATA/bili_jct/buvid3/DedeUserID）存 `~/.dsh/baleen/credentials/bili-cookie.txt`（纯 Cookie 头格式）。
- preference.yaml 加一条 `type: bili` 源（UP 主 space URL）→ 面板跑一轮 → bili 条目入库（body_state=subtitle）→ 会话判断（模型可调 baleen.subtitle 现取字幕）→ 汇报。
- verification.md 记录：三态字幕的实测分布、412/风控是否出现、登录态过期模拟（删 cookie 文件）只影响该源。

## 不做（M4a）

- xhs（M4b）、yt 适配器（M4b）、V5 内嵌播放器（先探后定）、评论工具、get_user_followings（隐私敏感，Baleen 不需要）。
