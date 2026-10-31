# M6 计划：小红书通道（xhs）接入

日期：2026-11-01。前置：V3 审查与冒烟已完成（`docs/v3-xhs-mcp-audit.md`，结论：Go 候选 xiaohongshu-mcp v2.5.5 可用，三前提之 ②③ 已实测，① 的实现取"客户端侧强制拒绝"变体）。

## 选型落地形态

- **子进程**：baleen 按偏好 `xhs.mcp_path` 拉起官方 exe（`-port 127.0.0.1:<port> -token <每boot随机>`，`COOKIES_PATH=<home>/credentials/xhs-cookies.json`）。token 每次启动随机生成、只活在本进程内存——spawn 侧与 HTTP 侧同源，不落盘不进日志（红线：token 不进日志）。
- **写工具防线**（三前提之 ①，客户端侧拒绝变体）：`lib/mcp/xhs-client.js` 维护只读工具白名单（9 个，与审查清单一致），`callTool` 对白名单外的名字直接抛错、零 HTTP 往返。写工具永远不被 baleen 调用，也永远不进 agent 工具面（工具面仍恰好六个）。
- **凭据**：MCP 自管 `xhs-cookies.json`（落在 baleen 家 credentials/ 下，同 B 站 cookie 的家）。过期 → 适配器钉 `needs_login` → 源红点 + 汇报明写「小红书本轮跳过（未登录）」。
- **登录入口**：设置页凭据区新增「小红书扫码登录」——宿主侧两条新路由（`GET /xhs-login-qr`、`GET /xhs-status`），面板→宿主，不进 agent 工具面（与 /collect、/open 同规矩）。

## 源 schema

```yaml
sources:
  - id: xhs-cafe
    type: xhs
    query: 手冲咖啡     # 搜索关键词（xhs 源的主键，url 字段不用）
```

`KNOWN_TYPES` 收 `'xhs'`；校验：`query` 必填非空。偏好新增顶层 `xhs: { mcp_path: '', port: 18060 }`（mcp_path 空 = xhs 通道整体不启用，源请求按 `mcp_missing` 失败并明说）。

## 摄取链路

`fetchXhs(source, …)`：`needs_login` 探测 → `search_feeds(query)` → knownIds 过滤 → 每轮上限 12（同 bili/yt 的预算分批）→ `get_feed_detail` 受限并发 2 → RawItem[]：

- `note_type`: noteCard.type（`video` → kind video；`image`/`normal` → kind note——normalize.js 的 image→note 分支是 M1 预留位）
- `external_id`: 笔记 id；`url`: `https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>`（详情必需 token，随 URL 保全）
- `body_html`: 笔记 desc；`title`: displayTitle；`thumb`: 封面 URL；`stats`: liked/collected/comment
- `published_at`: 笔记无绝对时间则 null（time_estimated=1，与设计一致）

## 错误分类（pool 纪律内）

`needs_login` / `mcp_missing` / `xhs_risk`（风控）/ `empty` / `bad_source`——全部走 `err.error_class` 钉住，pool 零改动。

## 任务分解

1. preference：KNOWN_TYPES + xhs 校验 + xhs 配置块
2. `lib/mcp/xhs-client.js`：MCP streamable HTTP 客户端（会话缓存、Bearer、只读白名单）+ 子进程生命周期（惰性 spawn、端口就绪探测、stopAll）
3. `lib/adapters/xhs.js`：fetchXhs（上面的链路）
4. 注册表登记 + index.js 生命周期挂钩（ctx.effect → stopAll）
5. 测试：假 MCP HTTP 服务器打桩——白名单拒绝、needs_login、映射、knownIds、上限、mcp_missing
6. 设置页：凭据区「小红书扫码登录」+ 状态；源占位文案更新
7. 宿主路由：GET /xhs-status、GET /xhs-login-qr（面板→宿主，非 agent 工具）

## 明确不做（本轮）

- Go fork（Leakless(false)、服务端裁剪写工具）——客户端拒绝已满足红线；fork 留给"宿主侧加固"后续任务
- 评论/点赞等一切平台写能力的调用路径（红线，无商量）
- 每源多关键词——一个源一个 query，多关键词就多配几个源

## 验收

- 单测全绿（新增假 MCP 打桩用例）
- 真机：preference 加一个 xhs 源 → 跑一轮 → 条目入库、判断、汇报出现小红书条目；未登录路径汇报明写跳过
