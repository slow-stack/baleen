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
- [x] 重新完整克隆 `7797fd3` 并核对后续变更（2026-11-01：上游 main 无 `7797fd3` 之后的提交；release v2.5.5 与 HEAD 的 7 个安全面文件——main/middleware/routes/mcp_server/cookies/browser_download/service——逐一 raw 比对**完全一致**，审查结论对官方 exe 直接适用）
- [x] 冒烟：官方 exe + token + 回环绑定起服务，`check_login_status` → 真人扫码 → `search_feeds` 一次（2026-11-01，结果见下）

## 冒烟结果（2026-11-01，官方 exe v2.5.5，本机）

**环境与完整性**：`xiaohongshu-mcp-windows-amd64.exe` v2.5.5，size 15,612,416 = 官方 API size，sha256 与官方 digest `cb55674f…` 一致。运行参数 `-port 127.0.0.1:18060 -token <随机48位>` + `COOKIES_PATH` 指到冒烟目录——回环绑定与凭据收敛两条前提实测可行（审查三前提之 ②③ 的落点）。

**通过的步骤**：
1. 首启自动下载内置浏览器 148.0.7778.215（带 SHA256SUMS 校验），解压即用；
2. `Registered 18 MCP tools` 与审查清单一字不差；`initialize` / `tools/list` / `tools/call` 全链路（官方 go-sdk 的 streamable HTTP + Bearer 鉴权）工作正常；
3. `check_login_status`：如实返回未登录 → 扫码后如实返回已登录（headless 浏览器真实访问小红书探测）；
4. `get_login_qrcode`：返回 PNG base64，扫码登录闭环可用；
5. `search_feeds`：返回结构化 feeds（id / xsecToken / 标题 / 作者 / 互动数 / 封面）——正是摄取适配器需要的字段。

**冒烟暴露的两个可用性坑（接入时要吸收）**：
1. **Windows Defender 拦截 go-rod 的 leakless 助手**（`Trojan:Win32/Kepavll!rfn`，已知误报）：不加排除浏览器起不来。本次以窄排除 `%TEMP%\leakless-amd64-*` 解除（用户拍板，UAC 确认）。**接入时该排除要写进安装文档**；或 fork 时顺手 `Leakless(false)`（接入的 fork 反正要做，见三前提之 ①）。
2. **`search_feeds` 冷启动超时**：首搜超过工具内部 60s 限时，rod panic 被服务端 panic-recovery 转成错误回显（不崩服务）；暖机重试即成功。摄取适配器的并发池本来就有"重试 1 次"纪律，天然吸收。

**测试产物**（`D:\v3-xhs-smoke\`，与仓库隔离）：`repo/`（克隆，HEAD `7797fd3`）、`bin/`（digest 校验过的 exe）、`scripts/smoke.mjs`（MCP 探测脚本）、`runtime/`（服务日志、**cookies.json 含真实登录态**——不再冒烟时应删除，或保留供后续联调）。

**结论**：三前提之 ②③ 已实测可落地，①（fork 裁剪写工具）仍待接入时做。可用性冒烟**通过**——余下的就是拍板：按三前提接入（fork 一次成型），还是 v1 先砍。
