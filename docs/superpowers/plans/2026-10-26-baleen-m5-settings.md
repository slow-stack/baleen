# M5 计划：设置页（DSH 设置里的 Baleen 一页，四页签）

> 里程碑收尾。**Spec 依据：主设计 §9**（四页签表 + "页签只写 preference.yaml"）。**范围裁定**：spec 表里的"小红书扫码登录"（xhs 未接入，M4b 阻塞）与"装转写依赖"（ASR 未实现）在页签里显示**诚实的未接入状态**，不做假按钮；spec 提的 `config.json` 运行态在现实现中不存在（preference.yaml 是唯一真源）——按实现走，计划记一句偏差。

**宿主 API 事实（本机 study-desk 实测形态，抄不发明）**：
- 客户端注册：`reg('settings.section', { name:'settings.section', id:'baleen-settings', order:28, label:'Baleen' }, () => h(Settings), 'settings.section')`——Baleen 的 `reg` helper 已在 `_footer.txt`，同款加一条。
- 设置组件是普通 React 组件（study-desk 的 Settings 用自有 store；Baleen 的走 view-api 调宿主路由）。
- 家目录显示用 `<HOME>` 占位（`/state` 先例，index.js:151）。

## Task 1: preference 读写路由（宿主半）

- `GET /api/dsh-baleen/preference` → `{ ok, pref, errors }`（loadPreference 原样 + 校验错误；含 tuning 只读展示）。
- `PUT /api/dsh-baleen/preference` body `{ section, value }`，section ∈ `sources|follow|themes|redlines|schedule|limits|charter|require_theme_hit|inject_prompt`：
  - 读现库偏好 → 合并该节 → `validate()` 整份校验 → **不过就 400 带错误清单，一个字不写**（与"校验不过整轮不启动"同哲学）；
  - 过了就**原子写**（新 helper `writePreference(dir, obj)`：tmp 文件 + rename；`lib/preference.js` 新增，YAML.stringify 保序 header）；
  - `section === 'sources'` 时写完调 `syncSources(db, pref)`（镜像进表，与启动一致）；
  - **tuning / version 拒绝**（400 `readonly_section`——tuning 只走 /feedback 与归零路由）。
- `POST /api/dsh-baleen/tuning-reset` → tuning.source_delta 清空（`clearTuningFile(dir)` 新 helper，原子写回）+ 日志一行（不含源 id 明细也行，条数即可）。
- 测试：GET 形状、PUT 每节合法值落盘且重启加载一致、非法值 400 且文件未动（mtime/内容比对）、sources 变更镜像进表、tuning/version 拒绝、归零后 /feedback 再 +0.1 仍工作、坏 YAML 请求体 400。

## Task 2: 凭据与环境路由（宿主半）

- `GET /api/dsh-baleen/credential-status` → `{ ok, bili: { present, updated_at } }`（文件存在性与 mtime，**绝不回内容**）。
- `PUT /api/dsh-baleen/credential` body `{ which:'bili', content }` → 校验非空字符串（含 SESSDATA 字样才收？**不校验内容**——只写文件 `credentials/bili-cookie.txt`，目录不存在则建；成功回 status；**内容零日志**，日志只有 which 与字节数）。
- `GET /api/dsh-baleen/env-check` → `{ ok, node: process.versions.node, yt_dlp: <version|null>（spawn `yt-dlp --version`，30s 超时，失败 null，进程内缓存 10 分钟）、bili_cookie、db_bytes、home_writable }`——全部只读探测。
- `GET /api/dsh-baleen/diagnostics-tail?lines=50` → `{ ok, lines: [...redact() 过的最后 N 行原文] }`（复制诊断用；redact 已有 lib/diag.js）。
- 测试：状态不回内容、写入后状态翻转、内容零日志（断言 diagnostics.jsonl 不含 SESSDATA 串）、yt_dlp 探测（spawnImpl 注入桩）、tail 走 redact（夹具里塞家目录路径断言被换掉）。

## Task 3: 库管理路由（宿主半：导出 / 清理 / 清空）

- `POST /api/dsh-baleen/export` → 生成 Markdown（全部未归档+已判条目：标题/链接/档位/理由/时间，按源分组）写 `home/out/baleen-export-<ISO 时间戳>.md` → `{ ok, file: 文件名, bytes }`（只回文件名不回绝对路径——展示层拼 `<HOME>`）。
- `POST /api/dsh-baleen/cleanup` body `{ days }`（≥1 整数）→ **先备份**（sqlite 主文件 copy 到 `home/backups/baleen-<ts>.sqlite`，wal 模式下用 sqlite 的 backup？简化：`db.prepare('VACUUM INTO ?')`——node:sqlite 支持）→ 删 `status='archived' AND fetched_at < now-days` 的条目（**只清归档**，new/judged 不动——裁定记录：清理是磁盘卫生不是记忆删除）→ `{ ok, removed, backup }`。
- `POST /api/dsh-baleen/wipe` body `{ confirm: '清空库' }`（字面量不等就 400）→ 先 VACUUM INTO 备份 → 清 items/runs/digests（**folders 保留**——夹结构是用户资产，默认夹不可删的红线延伸）→ `{ ok, removed: {items,runs,digests}, backup }`。
- 三条全记日志（事件名 export/cleanup/wipe，detail 只带数量与备份文件名）。
- 测试：导出文件内容含条目标题与档位、cleanup 只删归档且备份可打开（新连接查表）、wipe 字面量门 + 备份存在 + folders 还在 + 默认夹仍在、次数与日志断言。

## Task 4: 设置页客户端（settings.section + 四页签）

- `_footer.txt`：`reg('settings.section', { name:'settings.section', id:'baleen-settings', order:28, label:'Baleen' }, () => h(SettingsView, { key:'settings' }), 'settings.section')`。
- `src/client/views/settings.js` 新建 `SettingsView`——内部四页签（自有 tab state，样式照收藏页左列的 foldertab 模式）：
  1. **源**：列表（id/类型/开关/频率/权重/最近结果——最近结果从 /state 的 sources 取）+ 增（表单：id/type/url/label/interval/weight）+ 删（二次确认，复用删夹确认模式）+ 改（enabled 开关即时 PUT）。yaml 源真源在 preference，PUT sources 全量（读-改-写）。
  2. **偏好**：themes 文本编辑（每行 `组名: 词1,词2` 的简明格式 ↔ 结构互转，坏行标注不落盘）、redlines 行编辑、schedule（windows 行编辑 + max_per_run/max_per_day 数字 + off_peak_only 开关）、limits（max_age_days/min_duration_sec/skip_kinds）、require_theme_hit/inject_prompt 开关、charter 文本域、**tuning 一览 + 一键归零按钮**（调 tuning-reset，归零前确认）。
  3. **凭据与环境**：bili cookie 状态 + 粘贴写入（textarea，提交后清空输入框）；env-check 展示（node/yt-dlp/库大小/家目录可写）；xhs 与 ASR 显示"未接入（M4b 待做）"的诚实占位；复制诊断按钮（fetch tail → navigator.clipboard，失败降级为显示文本块）。
  4. **库**：数据目录（`<HOME>` 占位显示）、导出按钮（回执显示文件名+字节）、按天数清理（数字输入+确认，回执 removed/backup）、**清空库**（红字 danger + 输入"清空库"字面量确认，回执备份名）。
- `view-api.js` 加对应方法（preferenceGet/put、tuningReset、credentialStatus/put、envCheck、diagTail、exportMd、cleanup、wipe）——全部走既有 call/post 形态。
- 预览门：`preview-settings.html`（四页签各一块或四页？**一页内四块纵排**更省——预览是给人看的，四块全展示，明暗两版）；夹具加 settings 所需假数据；preview.test 断言四页签关键元素与诚实占位文案。
- CSS：零颜色、清单 token、危险操作红字用 `state-error-primary`（清单内）；client.js 重新生成。
- 测试：views-settings.test.js（四页签渲染、增删改交互、坏 theme 行标注、归零确认、清空库字面量门、占位文案）；client-boot.test.js 加 settings.section 注册断言；build.test 的 PARTS 登记 settings.js。

## Task 5: 真机验收 + 文档

- 重启宿主 → DSH 设置里出现 Baleen 页（**V4 正式闭环**）→ 四页签逐项实操：加源→跑一轮生效、改 max_per_run、粘 cookie（用现有 cookie 重粘一遍验证状态翻转）、归零 tuning（再按一次 +0.1 验证恢复）、导出/清理/清空（清空用备份恢复回来？**不清空真库**——清空只在空库状态验一遍 confirm 门即可，真数据用 cleanup 0 条场景验）。
- verification.md V4 关闭 + M5 记录；README 状态行与测试数；M2 计划偏差记录补 M5 交叉引用；AGENTS.md 如有新红线（"设置页 PUT 永不写 tuning/version"）补第 13 条。

## 全局约束（本计划特有）

- **PUT preference 白名单节**，tuning/version 永远 400；写前整份校验，不过一个字不落盘；原子写（tmp+rename）。
- 凭据内容**零日志零回显**（状态只回存在性+mtime）。
- 清理/清空**备份先行**（VACUUM INTO），备份文件名进回执；wipe 要字面量确认。
- 零新增依赖（yaml 已有；VACUUM INTO 是 sqlite 内建）。
- client.js 生成纪律、CSS 零颜色、同名 const 陷阱照旧。

## 不做

- ASR 安装开关与 xhs 扫码（随 M4b 一起，页签显示未接入状态）。
- config.json 运行态（spec 时代设计，现实现无此文件——偏差记录说明）。
- 主题词的可视化构建器（文本格式够了，v1 不做拖拽）。
