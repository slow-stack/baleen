# V3：小红书 MCP 候选安全与可用性审查（2026-10-31）

设计文档 V3 的验收：读源码列权限（网络出口、文件写入、凭据存放），本地起服务测一次搜索；失败退路是换候选、再不行 v1 砍掉小红书保留接口位。本文是前半（源码审查）的完整记录；冒烟测试（后半）待选型拍板后进行——搜索接口被登录墙挡住，完整冒烟需要真人扫一次码。

审查方式：两仓库浅克隆到独立临时目录（只读铁律，未执行任何下载的代码），由两个只读探查代理按统一七项清单扫描，关键结论（凭据、网络出口、写工具面）均带 `文件:行号` 证据。

**方法偏差（如实）**：Go 候选（xiaohongshu-mcp）的克隆因网络中断损坏（`early EOF / invalid index-pack`，git 已自清理），该候选的全部证据改从 GitHub 上游 main（HEAD `7797fd3`）只读取证；**采用前须重新完整克隆并核对 `7797fd3` 之后的变更**。Node 候选（xhs-mcp）本地克隆完整，证据出自本地。

## 结论速览

| | ShunL12324/xhs-mcp（Node + Playwright） | xpzouying/xiaohongshu-mcp（Go） |
|---|---|---|
| 总体判断 | **换候选** | **可审慎采用（附三前提）** |
| 许可 / 维护 | MIT；最近提交约 8 个月前 | Apache-2.0；pushed 2026-10-26，16.7k star，活跃 |
| 工具面 | 35 个全部无条件注册 | 18 个全部无条件注册 |
| **写平台动作** | 发笔记（图文/视频/草稿）、点赞、收藏、评论、回复、评论点赞，**外加默认 50% 概率自动点赞、10% 自动评论的 `xhs_explore`** | 8 个：发布图文/视频、评论、回复评论、点赞、收藏、通知回复、通知点赞 |
| 只读开关 | 无 | 无 |
| 网络出口 | 小红书两域 + **第三方 `api.qrserver.com`（登录 QR token 外泄）** + **Google Gemini（笔记内容/图片/评论外发）** + 任意 URL 下载器 | 小红书两域 + 作者 CDN `cdn.one-world.ai`（浏览器分发，带 SHA256 校验）+ 调用方传入的图片 URL |
| 凭据存放 | 明文 JSON 进 SQLite `accounts.state`，无加密无 chmod；**仓库 scripts 里硬编码疑似真实 cookie**（`scripts/import-cookies.ts:17-37`） | 明文 JSON `0644` 落 `cookies.json`（cwd 或 /tmp 兜底）；不进日志不上传；可 `delete_cookies` 重置 |
| 危险面 | 无 eval/子进程；**HTTP 模式无鉴权 + CORS 全开 + 依赖 Bun**；浏览器必须系统 Chrome；三个原生依赖（better-sqlite3/sharp/canvas） | 无动态执行；首启下载 140-190MB Chromium（SHA256 校验，但工件与哈希同源作者 CDN）；**默认无鉴权绑全部网卡** |
| Windows 可用性 | 可跑但坑多（Chrome 依赖、原生模块、stdio 模式才行） | 官方 `windows-amd64.exe` + 专门图文指南；进程内解压浏览器 |
| 红线冲突（只读） | 直接冲突且最恶劣（自动点赞/评论默认开启） | 冲突但可控（写工具不会被 baleen 注册，暴露面可收敛） |

## 双方共同的根本问题

两个候选都**不是只读 MCP，且都没有按类别裁剪工具面的开关**。baleen 的红线（AGENTS.md #2：绝不注册平台写操作）指的是我们不把它们注册进 agent 工具面——集成形态是摄取适配器内部调 `search_feeds` / `get_feed_detail` 填库，agent 工具面仍是固定六个，MCP 的写工具天然不会被注册。但这不等于风险归零：子进程 HTTP 端口上的写工具对本机其他进程可达。

## 若采用 Go 候选，三个前置条件（审查结论原文）

1. **只读收敛**：fork 裁掉 8 个写平台工具（`mcp_server.go:1128/1253/1274/1304/1329/1350/1419/1435` 的注册点），或在客户端侧强制拒绝；`delete_cookies` 只删本地登录态，可保留。
2. **收敛暴露面**：`AUTH_TOKEN` 显式设置 + 改绑 `127.0.0.1`（默认 `":18060"` 绑全部网卡且无鉴权放行，`middleware.go:346-353`）。
3. **供应链收敛**：Chromium 工件与校验哈希同出作者 CDN（`cdn.one-world.ai`，版本钉死 `148.0.7778.215`），建议离线预置或自建镜像后再上。

## Node 候选的三条红色信号（为何直接换掉）

1. `xhs_explore` 默认 `likeRate=0.5 / commentRate=0.1` 自动点赞发评（`services/explore.ts:131-133,347,391`）——这不是"存在写工具"，是**默认就在写平台**。
2. 登录 QR token 经第三方 `api.qrserver.com` 渲染（`src/core/login-session.ts:20,144-147,247`）。
3. 仓库提交了疑似真实 cookie（`scripts/import-cookies.ts:17-37`）——凭据管理随意。

## 集成成本备注（baleen 侧现状）

`lib/preference.js` 的 `KNOWN_TYPES` 未收 xhs、`lib/adapters/index.js` 留了接口位、设置页有"小红书：未接入"诚实占位。baleen 目前**没有任何 MCP 子进程管理设施**（B 站走了纯 fetch 直连，设计文档里的 vendor MCP 计划未实施）——接入 Go 候选要新建子进程生命周期管理（spawn、登录态探测、`needs_login` 跳过语义已在设计文档 D3 定义）。

## 待办

- [ ] 拍板：按三前提接入 Go 候选 / 继续找更只读的候选 / v1 砍掉保留接口位
- [ ] （若接入）重新完整克隆 `7797fd3` 并核对后续变更
- [ ] （若接入）冒烟：官方 exe + `AUTH_TOKEN` + 回环绑定起服务，`check_login_status` → 真人扫码 → `search_feeds` 一次
