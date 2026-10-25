# VENDOR-NOTES — BiliStalkerMCP

vendored 上游：**BiliStalkerMCP**（https://github.com/222wcnm/bilibili-user-updates-mcp）

- 上游 commit：`952fd83b9089b3f1b5bfde730b968fe63e3eb6df`（`feat: add explicit subtitle page scope and selection`），版本 v3.6.0.dev0，MIT（LICENSE 副本在本目录）。
- vendored 日期：2026-10-25。
- 审查：前置源码审查 **approve with conditions**（本目录与 Baleen 仓库内只放下列文件；审查要点见 `docs/superpowers/plans/2026-10-25-baleen-m4a-bili.md` 前置审查段）。

## 本目录内容（仅此四件 + 本说明）

- `bili_stalker_mcp/` — 上游源码（含两处补丁，见下）
- `pyproject.toml` — 上游原件，逐字节未动（其中 `bilibili-api-python==17.4.2` 等只是**依赖声明文本**；GPL 的 bilibili-api-python 由 pip 在运行时装进 conda 环境，**绝不进 Baleen 仓库**）
- `uv.lock` — 上游锁文件原件
- `LICENSE` — 上游 MIT 许可证副本
- `README.md` — 上游 README 副本。简报清单没有它，但 `pyproject.toml` 的 `readme` 键引用该文件，缺了 `pip install -e` 直接构建失败；取上游原件而非改 pyproject，保持清单文件逐字节一致。

`pip install -e vendor/bilibili-mcp` 会生成 `*.egg-info/`、`__pycache__/` 等产物，已被仓库根 `.gitignore` 覆盖，不入库。

## 审查条件与落地方式

1. **GPL 依赖绝不进 Baleen 仓库**：本目录只有上面列的 MIT 源码与清单文件；`bilibili-api-python==17.4.2` 锁在 `uv.lock`/`pyproject.toml` 的声明文本里，实际安装发生在 conda 环境 `baleen-bili`（Python 3.12）。
2. **重试预算**：Baleen 红线"重试上限 1 次"——vendor 内部重试即 Baleen 的那 1 次，适配器层零重试。补丁 B 把 vendor 内全部 `max_retries` 默认压到 1。
3. **凭据**：全部工具硬依赖 SESSDATA（`server.py` 的 `_get_credential_from_context` 无凭据直接抛 ToolError）。Baleen 侧凭据放 `credentials/bili-cookie.txt`（纯 Cookie 头格式）经 env `BILI_COOKIE_FILE` 注入——由 bili 适配器任务实现；`credentials/` 已在仓库根 `.gitignore`。
4. **`BILI_ENABLE_COOKIE_REFRESH` 不设**：不启用 cookie 自动刷新/回写，凭据目录只读消费。

## 补丁清单（对上游源码的全部改动）

### 补丁 A：`VideoListItem` 补 `pic` 封面字段

上游 B 站 space arc-search 的 `vlist` 响应带封面 URL（`pic`），但模型没接，下游拿不到缩略图。两处一起改才算一个补丁（只加模型字段是死字段）：

- `bili_stalker_mcp/models.py`：`VideoListItem` 增加 `pic: str | None = Field(default=None, description="Cover image URL.")`——字段名与 `VideoDetailItem.pic`（上游自身已有，video detail 路径在用）及 B 站列表 API 响应键一致。
- `bili_stalker_mcp/services/user_service.py`：`_fetch_user_videos_cached` 里 `VideoListItem(...)` 显式构造处加 `pic=video_data.get("pic"),`。

### 补丁 B：`max_retries` 一律 ≤1（原默认 3）

Baleen 红线重试≤1；`with_retry` 语义是 `range(max_retries + 1)` 次尝试（1 次初始 + max_retries 次重试），故 `max_retries=3` 意为最多重试 3 次，超预算。除 `user_service.py` 原有的 `max_retries=1`（`_search_users_cached`，保持不动）外，全部压到 1：

- `bili_stalker_mcp/retry.py`：`with_retry` 签名默认 `max_retries: int = 3` → `1`。
- `bili_stalker_mcp/services/user_service.py`：`_fetch_user_info_cached`、`_fetch_user_videos_cached`、`_fetch_video_detail_cached`、`fetch_user_articles`、`fetch_article_content`、`fetch_user_followings` 六处显式 `max_retries=3` → `1`。
- `bili_stalker_mcp/services/dynamic_service.py`：`_fetch_dynamics_page` 一处 `max_retries=3` → `1`。
- `bili_stalker_mcp/services/comment_service.py`：`fetch_content_comments`、`fetch_content_comment_replies` 两处 `max_retries=3` → `1`。
- `bili_stalker_mcp/services/subtitle_service.py`：`_fetch_subtitle_payload` 一处 `max_retries=2` → `1`（简报只点名了 `=3` 的处，但 `=2` 同样超"重试≤1"预算，且落在字幕路径上，一并压到 1）。

每处改动均带 `Baleen vendor patch` 注释标记，`grep -rn "vendor patch" bili_stalker_mcp/` 可全数找到。

## 升级流程（给未来的自己）

1. 重新 clone 上游，确认新 commit 仍 MIT、仍 12 工具全只读、外联仍仅 bilibili 系域名；GPL 依赖清单有变则重新审查。
2. 重新套上面两处补丁（带注释标记，容易对齐），重跑冒烟：`conda run -n baleen-bili python -m bili_stalker_mcp tools` 应列出 12 个工具。
3. 更新本文件的 commit 与补丁清单。
