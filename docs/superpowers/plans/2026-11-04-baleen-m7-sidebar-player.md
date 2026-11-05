# Baleen 侧栏播放器（M7）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让视频在 DSH 内看完不去平台——抽屉里已内嵌播（V5），本计划把同一个播放器接入 dsh-better-sidebar 的侧栏，并可选择性接管会话里点开的 B 站/YouTube 链接。

**Architecture:** 三段。① 纯视图 `PlayerTab`（复用 `playerEmbed()`，带可关的推荐区裁切）；② 纯构建模块 `sidebar-tab.js`（seed 形状、`urlTarget` 谓词、descriptor），全部可用假 service 单测；③ 装配层 `_footer.txt` 用 `safeGet('betterSidebar')` 软取服务并注册，取不到就整段跳过，面板其余功能不变。侧栏只读播放，不做收藏/权重，也不放宽 `/open` 的 item_id 守卫。

**Tech Stack:** 原生 ESM（Node 24）、`node --test`、宿主 slot API（`ctx.slots`）、dsh-better-sidebar 0.28.2 的 `ctx.betterSidebar` 服务、`node:sqlite`（本计划不碰）。无新增 npm 依赖。

**Spec:** [docs/superpowers/specs/2026-11-04-baleen-m7-sidebar-player-design.md](../specs/2026-11-04-baleen-m7-sidebar-player-design.md)

## Global Constraints

- 零新增 npm 依赖（本仓库只允许 `yaml`）；接入 better-sidebar 只用**服务名** `betterSidebar`，不引包。
- 工具面恰好六个：`baleen_query / read_item / candidates / run_status / subtitle / save_verdicts`；本轮不注册任何 agent 工具。
- 绝不注册平台写操作（评论/私信/点赞/关注/发布/收藏到平台）。
- 三档词固定：`值得看` `可以看` `不值当`；不写分数。
- `body_state` 六值固定：`full` `summary_only` `subtitle` `transcribed` `missing` `burned_in`。
- 两个粗调按钮只写 `tuning`，永不改 `themes` / `follow` / `sources`。
- 日志与诊断脱敏：不含用户名、家目录绝对路径、token/cookie；测试里用 `<HOME>` / `os.homedir()`。
- 测试只用 `node --test`，命令一律写 `node --test "test/*.test.js"`（Windows 下 `node --test test/` 会报错）。
- `client.js` 是生成产物，**绝不手改**；改完 `src/client/` 必须 `node tools/build-client.mjs`，验收用 `npm run build:check`。
- `src/client/` 下每个 `.js` 都必须登记进 `tools/build-client.mjs` 的 `PARTS`，漏登记 = 面板毫无变化且不报错（`test/build.test.js` 卡这条）。
- 内联生成 = 同一作用域，两个源文件里的同名 `const` 会 `SyntaxError`；节点工厂一律用 `src/client/vnode.js` 的 `vnode()`。
- CSS 只用宿主 token（`test/css.test.js` 的 `HOST_TOKENS`：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-border-l1..l4`、`--dsw-alias-label-primary/secondary/tertiary/dimmed`、`--dsw-alias-brand-primary`、`--dsw-alias-interactive-bg-hover/active`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary`），不写死颜色，不加 `light-dark()` 兜底。
- 工作副本是 CRLF：多行锚点的脚本要匹配 `\r?\n`。
- `/open` 路由只接受 `item_id`、URL 由宿主查库取——本轮不为侧栏放宽这条守卫。
- 提交信息用中文；一个任务一次提交。

---

## 决策缝（Task 1 已填，2026-11-05 第二轮实测）

```
MODE = 'url'            # 会话在前台时 openTab({url}) 当场开进原生右侧栏（实测）
PANEL_BUTTON = 'no'     # 面板在前台时 openTab 进 pending 队列、什么都不出现（实测）→ 待用户拍板撤掉还是改话术
TITLE_SOURCE = '未验'    # 本轮是显式传 title；urlTarget 接管路径按 service.d.ts:215 应为 hostname
```

证据见 [docs/verification.md](../../verification.md)「M7 侧栏探针：两轮结果」。关键一条：`dsh-better-sidebar/src/client/native/surface.ts:146-162` —— `onScreen = mountedSessionId(ctx) === entry.sessionId` 不成立时 open **排队等会话回到前台**，`openTab` 返回 void，调用方拿不到失败信号。**两个落点都是会话作用域的**，所以 `urlTarget` 外链接管是唯一必然满足前台条件的入口。

副作用：Task 6 的「侧栏播放」按钮受阻（待拍板），Task 4 / 5 按 `MODE='url'` 可以开工。

---

### Task 1: 真机探针（P1–P4），只改文档不改代码

> **第一轮已跑（2026-11-04，未重启）**：P2 与服务能力已定（`ctx.get('betterSidebar')` 可取、`openTab` 存在、内置 6 个 tab 类型里**没有**可复用的 browser/iframe tab）；P3/P1/P4 **未定**，判据被三个污染项废掉——详见 [docs/verification.md](../../verification.md) 的「M7 侧栏探针：第一轮结果」。
> **下一轮开头必须先做**：① 确认 `bl-probe` 覆盖层与 `dsh-baleen:probe` 注册已随渲染进程重载消失（应用内 `Ctrl+R`，焦点要在应用而不是 DevTools 上）；② P3 判定一律**先关 DevTools 再看屏**（停靠的 DevTools 恰好压住 `openTab({meta})` 的落点：底部工作台）；③ 结论只看截图，不用 `innerText`/`querySelectorAll`；④ 点元素前用文本重新核对序号。

**Files:**
- Modify: `docs/verification.md`（V5 一节的未验项 + 新增「M7 探针记录」小节）
- Modify: `docs/superpowers/specs/2026-11-04-baleen-m7-sidebar-player-design.md`（§2 的 D5、§3 表格的结论列）

**Interfaces:**
- Consumes: 无
- Produces: 本文件头部的「决策缝」三行被填实；`MODE` 是 Task 4/5 的输入常量。

- [ ] **Step 1: 重启前的安全检查（不得跳过）**

```bash
cd /d/dsh-baleen
grep -n baleen ~/.dsh/profiles/desktop/cordis.patch.yml   # 宿主 profile 那份，不是仓库这份
```
Expected: 能看到 `dsh-baleen` 的 link 装配条目。**条目没了就先补装配**（`dsh plugin --profile desktop add link:D:/dsh-baleen`）再继续，否则重启后插件整个不加载。
重启方式：**优雅关窗**（点 ✕），禁止 `Stop-Process -Force`——强杀会写坏会话日志（`docs` 与 zcode 记忆里都有实证）。

- [ ] **Step 2: P1 —— 抽屉内嵌播放器真机验收**

打开 Baleen 面板 → 「视频」页 → 点一条 `bilibili.com/video/BV…` 条目开抽屉。判据：出现「内嵌播放」区，且点播放器后画面在 iframe 内动、DSH 标题栏不变（说明没跳走）。
若抽屉滚不到播放器：按 zcode 记忆的手法——点一下正文再按 `End`（坐标 event click），不要用滚轮。

- [ ] **Step 3: P2 —— `betterSidebar` 服务可达性（DevTools console，非破坏）**

DevTools 是独立窗口，**先用 a11y 点 ⋮ → Dock side 停靠进主窗口，键盘才可用**。停靠后 console 里跑：

```js
const c = window.__dshClientCtx
const out = {}
try { out.getByGet = typeof c?.get?.('betterSidebar') } catch (e) { out.getByGet = 'throws: ' + e.message }
try { out.byProp = typeof c?.betterSidebar } catch (e) { out.byProp = 'throws: ' + e.message }
try { out.tabIds = c?.betterSidebar?.getTabs?.().map(t => t.id) } catch (e) { out.tabIds = 'throws' }
console.log(JSON.stringify(out, null, 1))
```
Expected: 至少一条通路拿到对象（`getByGet` 或 `byProp` 为 `'object'`），并列出内置 tab id。**注意**：`__dshClientCtx` 是否可达、以及控制台里的裸属性访问会不会因未声明 inject 而抛，本身就是探针要记录的事实——照实写进记录，别脑补。

- [ ] **Step 4: P3 —— 两个落点各试一次**

```js
const bs = window.__dshClientCtx.betterSidebar        // P2 里失败就换 ctx.get('betterSidebar')
let disposed = null
disposed = bs.registerTab({
  id: 'dsh-baleen:probe',
  title: 'Baleen 探针',
  description: '一次性探针，验完即删',
  component: ({ tab }) => {
    const src = tab?.url || (typeof tab?.meta?.url === 'string' ? tab.meta.url : '')
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;inset:0;background:#111'
    host.innerHTML = '<iframe style="width:100%;aspect-ratio:16/9;border:0" src="' +
      src + '" allow="autoplay; fullscreen"></iframe>'
    return host
  }
})
bs.openTab({ type: 'dsh-baleen:probe', url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: 'P3-A' })
```
记录三件事：① 出现在**原生右侧栏**还是**底部工作台**；② 打开时是否需要"前台有会话"（面板在前台时能不能开）；③ 16:9 在该容器里的实际可用宽高（截图存 `out/`）。
然后 `bs.openTab({ type: 'dsh-baleen:probe', meta: { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }, title: 'P3-B' })` 再记一遍，`disposed()` 删注册。

- [ ] **Step 5: P4 —— 外链接管是否生效**

会话消息里点一条 B 站链接（不带修饰键）→ 看是否被认领；再 `Ctrl+click` 同一条 → 应绕过去系统浏览器（`link-intercept.d.ts:12`）。同时记录 better-sidebar 设置里 `linkOpening` 的当前值。

- [ ] **Step 6: 把结论写进文档**

`docs/verification.md` 末尾新增小节，逐条写「探针 / 结论 / 证据（截图路径或 console 原文）」，并把 V5 遗留的"内嵌播放器未真机验收"改为已验。本文件头部「决策缝」三行填实。
**两个落点都不可用时**：`MODE` 填 `none`，停下，只推进 Task 2、Task 3、Task 6（抽屉播放 + 卡片文案），Task 4/5/7 的侧栏部分移出本轮，未验项写回 `docs/verification.md` 并报告原因——不许硬凑一个开不出来的入口。

- [ ] **Step 7: Commit**

```bash
git add docs/verification.md docs/superpowers/specs/2026-11-04-baleen-m7-sidebar-player-design.md docs/superpowers/plans/2026-11-04-baleen-m7-sidebar-player.md
git commit -m "docs: M7 侧栏探针记录——播放容器落点实测定为 <MODE>，V5 内嵌播放真机销账"
```

---

### Task 2: 两个布尔偏好（`sidebar_takeover` / `sidebar_crop`）

**Files:**
- Modify: `lib/preference.js:13-27`（`DEFAULTS`）、`lib/preference.js:254-259`（校验段，照 `inject_prompt` 的写法追加）
- Modify: `index.js:28`（`PREF_SECTIONS` 白名单）
- Test: `test/preference.test.js`、`test/host-surface.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `pref.sidebar_takeover: boolean`（默认 `true`）、`pref.sidebar_crop: boolean`（默认 `true`）；`GET /api/dsh-baleen/preference` 回带这两个键；`PUT { section:'sidebar_takeover', value:false }` 生效。Task 5 用 `GET /preference` 的返回值决定 `urlTarget` 是否认领、Task 3 用它决定 `crop`。

- [x] **Step 1: 写失败的测试**

在 `test/preference.test.js` 追加：

```js
test('默认值：侧栏接管与推荐区裁切都是开（关掉的代价由用户显式承担）', () => {
  assert.equal(DEFAULTS.sidebar_takeover, true)
  assert.equal(DEFAULTS.sidebar_crop, true)
})

test('sidebar_takeover / sidebar_crop 只收布尔，字符串一律拒', () => {
  assert.deepEqual(validate({ ...DEFAULTS, sidebar_takeover: 'yes' }), ['sidebar_takeover: 必须是布尔'])
  assert.deepEqual(validate({ ...DEFAULTS, sidebar_crop: 0 }), ['sidebar_crop: 必须是布尔'])
  assert.deepEqual(validate({ ...DEFAULTS, sidebar_takeover: false, sidebar_crop: false }), [])
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test "test/preference.test.js"`
Expected: FAIL，`DEFAULTS.sidebar_takeover` 为 `undefined`、`validate` 不报错。

- [x] **Step 3: 最小实现**

`lib/preference.js` 的 `DEFAULTS` 里 `inject_prompt: true,` 下一行加：

```js
  sidebar_takeover: true,    // 会话里点 B 站/YouTube 链接是否落进侧栏播放 tab
  sidebar_crop: true,        // 侧栏播 B 站时裁掉完整页自带的相关推荐
```

`lib/preference.js` 的 `inject_prompt` 校验段（约 257-259 行）之后照抄同一形状加两段：

```js
  if (obj.sidebar_takeover !== undefined && typeof obj.sidebar_takeover !== 'boolean') {
    errs.push('sidebar_takeover: 必须是布尔')
  }
  if (obj.sidebar_crop !== undefined && typeof obj.sidebar_crop !== 'boolean') {
    errs.push('sidebar_crop: 必须是布尔')
  }
```

`index.js:28` 的白名单里追加两个节名（整行替换）：

```js
const PREF_SECTIONS = new Set(['sources', 'follow', 'themes', 'redlines', 'schedule', 'limits', 'charter', 'require_theme_hit', 'inject_prompt', 'sidebar_takeover', 'sidebar_crop'])
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test "test/preference.test.js"`
Expected: PASS。

- [x] **Step 5: 补路由侧的测试并跑全量**

`test/host-surface.test.js` 里用该文件既有的 `apiOf(home)` / `fakeRes()` / `bodyOf(o)` 三件套（定义在 `test/host-surface.test.js:31-37` 与 `:270`），仿 `require_theme_hit` 那组（`:582`、`:659`）加一条：

```js
test('PUT sidebar_crop 走白名单：合法布尔落盘读回，非布尔按校验拒掉', async () => {
  const home = freshHome()
  const { h } = await apiOf(home)

  const off = fakeRes()
  await h({ url: '/api/dsh-baleen/preference', method: 'PUT', ...bodyOf({ section: 'sidebar_crop', value: false }) }, off)
  assert.equal(off.code, 200, off.body)
  assert.equal(JSON.parse(off.body).pref.sidebar_crop, false)

  const bad = fakeRes()
  await h({ url: '/api/dsh-baleen/preference', method: 'PUT', ...bodyOf({ section: 'sidebar_takeover', value: 'nope' }) }, bad)
  assert.equal(bad.code, 400)
  assert.ok(JSON.parse(bad.body).errors.some((e) => e.startsWith('sidebar_takeover')), bad.body)
})
```
（别新造 `putPref` 之类的 helper——这个文件的既有写法就是 `h({url, method, ...bodyOf(x)}, fakeRes())`。）

Run: `node --test "test/*.test.js"`
Expected: 全绿。

- [x] **Step 6: Commit**

```bash
git add lib/preference.js index.js test/preference.test.js test/host-surface.test.js
git commit -m "feat: 两个侧栏偏好（接管外链 / 裁推荐区），默认都开、只收布尔"
```

---

### Task 3: `PlayerTab` 视图 + 裁切容器 CSS

**Files:**
- Create: `src/client/views/player-tab.js`
- Modify: `tools/build-client.mjs:23-24`（`PARTS`）
- Modify: `src/client/css.js`（`CSS` 常量里追加 `.bl-stage*` / `.bl-tab*`）
- Test: `test/views-player-tab.test.js`（新）、`test/css.test.js`（确认 token 守卫覆盖新样式）

**Interfaces:**
- Consumes: `playerEmbed(url) -> { kind:'bili'|'youtube', src:string } | null`（`src/client/views/drawer.js:41`）、`vnode(type, props, children)`（`src/client/vnode.js`）
- Produces: `PlayerTab({ url: string, title?: string, crop?: boolean }) -> vnode`，根节点 className 为 `bl-tab`，播放器容器 `bl-stage`，iframe `bl-player`，裁切时容器额外带 `bl-stage-crop`。Task 5 的 tab 组件调它。

- [x] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { PlayerTab } from '../src/client/views/player-tab.js'
import { text, findAll } from './helpers/tree.mjs'

test('B 站可嵌入：侧栏 tab 画播放器，裁切时容器是 bl-stage-crop', () => {
  const t = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '某条视频', crop: true })
  assert.equal(findAll(t, 'bl-player').length, 1)
  assert.equal(findAll(t, 'bl-stage-crop').length, 1, '裁切容器必须在，否则推荐流露出来')
  assert.match(findAll(t, 'bl-player')[0].props.src, /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7$/)
  assert.match(text(t), /某条视频/)
})

test('关掉裁切：容器不带 bl-stage-crop，文案如实说会看到推荐流', () => {
  const t = PlayerTab({ url: 'https://youtu.be/dQw4w9WgXcQ', crop: false })
  assert.equal(findAll(t, 'bl-stage-crop').length, 0)
  assert.match(text(t), /推荐流/)
})

test('解析不出嵌入形态（含 b23.tv 短链）不画播放器，只说一句真话', () => {
  for (const url of ['https://b23.tv/x', 'https://example.invalid/a', '']) {
    const t = PlayerTab({ url })
    assert.equal(findAll(t, 'bl-player').length, 0, url)
    assert.match(text(t), /解析不出嵌入形态/)
  }
})

test('侧栏 tab 里没有收藏、没有调权重、没有"去浏览器"', () => {
  const t = PlayerTab({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })
  const s = text(t)
  assert.doesNotMatch(s, /收藏|不感兴趣|这源多来点|浏览器打开/)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test "test/views-player-tab.test.js"`
Expected: FAIL，`Cannot find module '../src/client/views/player-tab.js'`。

- [x] **Step 3: 写实现**

```js
/**
 * 侧栏/工作台里的播放器外壳。与抽屉共用 playerEmbed()——正则抄两遍必然漂移。
 * 这里只读：不收藏、不调权重、不提供"去浏览器"（/open 只认 item_id，侧栏手里只有 URL）。
 */
import { vnode } from '../vnode.js'
import { playerEmbed } from './drawer.js'

export function PlayerTab({ url, title = '', crop = true }) {
  const embed = playerEmbed(url)
  if (!embed) {
    return vnode('div', { className: 'bl-tab' }, [
      vnode('p', { className: 'bl-note' }, ['这个地址解析不出嵌入形态，侧栏播不了——回面板抽屉里用「浏览器打开」。'])
    ])
  }
  return vnode('div', { className: 'bl-tab' }, [
    title ? vnode('p', { className: 'bl-tab-title' }, [title]) : null,
    vnode('div', { className: crop ? 'bl-stage bl-stage-crop' : 'bl-stage' }, [
      vnode('iframe', { className: 'bl-player', src: embed.src, allow: 'autoplay; fullscreen', allowfullscreen: true })
    ]),
    vnode('p', { className: 'bl-note' }, [crop
      ? '侧栏只露播放器，下面的推荐流是故意裁掉的——不想让你刷下去。设置页「裁掉推荐区」关掉就还原。'
      : '完整页在这里，往下滑会看到平台的推荐流。'])
  ])
}
```

- [x] **Step 4: 登记 PARTS（漏了等于白写）**

`tools/build-client.mjs:23-24` 的 `PARTS` 数组末尾只追加本任务这一个文件（`sidebar-tab.js` 留给 Task 4；提前写进去会让 `test/build.test.js` 的"PARTS 里文件都存在"守卫立刻报红）：

```js
export const PARTS = ['view-state.js', 'view-api.js', 'vnode.js', 'match.js', 'format.js', 'css.js',
  'views/shell.js', 'views/today.js', 'views/video.js', 'views/article.js', 'views/digest.js', 'views/library.js', 'views/drawer.js', 'views/collections.js', 'views/settings.js',
  'views/player-tab.js']
```

- [x] **Step 5: 加 CSS（只走宿主 token）**

`src/client/css.js` 的 `CSS` 里 `.bl-player` 那行之后追加：

```css
.bl-tab{padding:8px;display:flex;flex-direction:column;gap:6px}
.bl-tab-title{margin:0;font-size:12px;color:var(--dsw-alias-label-primary)}
.bl-stage{--bl-window:360px;--bl-frame:900px;width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.bl-stage>.bl-player{display:block;width:100%;height:var(--bl-frame);aspect-ratio:auto;border:0;border-radius:0}
.bl-stage-crop{height:var(--bl-window)}
.bl-stage:not(.bl-stage-crop)>.bl-player{height:640px}
```

裁切原理：容器比 iframe 矮 + `overflow:hidden`，iframe 顶对齐，**下半截自然被掐掉**——不用 `position:absolute`（那样容器高度会塌成 0），也不往 iframe 里注入 CSS（跨源读不到，也不该读）。
`--bl-window`（露出多少）与 `--bl-frame`（iframe 内部视口多高）是一对**待实测的数**，由 Task 8 用真机截图定，不在这里假装知道。

注意这份文件的四条既有守卫会一起管你：`test/css.test.js:32` 禁一切颜色字面量、`:41` 只许用 `HOST_TOKENS` 里的名字、`:61` 字号只许 13/12/11、`:82` **视图里出现的每个 `bl-` 类名都必须有对应样式**（所以 `.bl-stage-crop` 自己得带一条规则，不能只当标记）。

- [x] **Step 6: 跑测试 + 生成 + 全量**

```bash
node --test "test/views-player-tab.test.js" "test/css.test.js"
node tools/build-client.mjs
npm run build:check
node --test "test/*.test.js"
```
Expected: 全部 PASS；`build:check` 无"client.js 已过期"。

- [x] **Step 7: Commit**

```bash
git add src/client/views/player-tab.js tools/build-client.mjs src/client/css.js client.js test/views-player-tab.test.js
git commit -m "feat: 侧栏播放器视图 PlayerTab——复用 playerEmbed，推荐区裁切可关"
```

---

### Task 4: `sidebar-tab.js` 纯构建模块（seed / 认领谓词 / descriptor）

**Files:**
- Create: `src/client/sidebar-tab.js`
- Modify: `tools/build-client.mjs`（`PARTS` 加 `'sidebar-tab.js'`）
- Test: `test/sidebar-tab.test.js`（新）

**Interfaces:**
- Consumes: `playerEmbed(url)`（drawer.js:41）；本文件头部的 `MODE`
- Produces:
  - `videoTabSeed(url: string, title: string) -> { type:'dsh-baleen:player', title:string, url?:string, meta?:{url:string,title:string} }`
  - `parseVideoUrl(raw: unknown) -> { kind, src, url } | null`（`null` = 不认领，含 `b23.tv`）
  - `buildTabDescriptor({ seed, render, flags }) -> TabDescriptor`，`flags = { takeover: () => boolean }`
  - `registerSidebarTab(service, descriptor) -> () => void`（失败返回 `() => {}` 并吐诊断，绝不抛）

- [x] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { videoTabSeed, parseVideoUrl, buildTabDescriptor, registerSidebarTab, TAB_ID } from '../src/client/sidebar-tab.js'

test('parseVideoUrl：可嵌入才认，b23.tv 短链和别的站点一律不认（抢了播不了更糟）', () => {
  assert.equal(parseVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3').kind, 'bili')
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ').kind, 'youtube')
  assert.equal(parseVideoUrl('https://b23.tv/x'), null, '短链解析不出 BV 号，不硬猜')
  assert.equal(parseVideoUrl('https://example.invalid/a'), null)
  assert.equal(parseVideoUrl('file:///etc/passwd'), null, '非 http(s) 不碰')
  assert.equal(parseVideoUrl(null), null)
})

test('urlTarget 按契约返回布尔（service.d.ts:217 是 `(url: URL) => boolean`），认不出来就 false', () => {
  const d = buildTabDescriptor({ seed: {}, render: () => null, flags: { takeover: () => true } })
  assert.equal(d.urlTarget(new URL('https://www.bilibili.com/video/BV1GJ411x7h7')), true)
  assert.equal(d.urlTarget(new URL('https://b23.tv/x')), false, '抢下来只会开一个播不了的 tab')
  assert.equal(d.urlTarget(new URL('https://example.invalid/a')), false)
})

test('关掉接管开关后 urlTarget 一律 false，但 tab 本体照旧注册', () => {
  const d = buildTabDescriptor({ seed: {}, render: () => null, flags: { takeover: () => false } })
  assert.equal(d.urlTarget(new URL('https://www.bilibili.com/video/BV1GJ411x7h7')), false)
  assert.equal(typeof d.component, 'function')
})

test('videoTabSeed 按 MODE 只带一种载荷，另一个键不许存在', () => {
  const s = videoTabSeed('https://www.bilibili.com/video/BV1GJ411x7h7', '某条视频')
  assert.equal(s.type, TAB_ID)
  assert.equal(s.title, '某条视频')
  if ('url' in s) assert.equal('meta' in s, false, 'url 与 meta 不许同时出现')
  else assert.deepEqual(s.meta, { url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '某条视频' })
})

test('dedupeKey 按 URL 去重：同视频复用 tab，不同视频各开一个', () => {
  const d = buildTabDescriptor({ seed: {}, render: () => null, flags: { takeover: () => true } })
  const tabOf = (u) => ({ id: 'x', type: TAB_ID, title: 't', meta: { url: u } })
  assert.equal(d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')), d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')))
  assert.notEqual(d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1A')), d.dedupeKey(tabOf('https://www.bilibili.com/video/BV1B')))
})

test('registerSidebarTab：service 缺席返回空 disposer 且不抛；注册抛错降级为一句诊断', () => {
  assert.equal(typeof registerSidebarTab(null, { id: TAB_ID }), 'function')
  assert.equal(typeof registerSidebarTab(undefined, { id: TAB_ID }), 'function')
  const boom = registerSidebarTab({ registerTab() { throw new Error('宿主没准备好') } }, { id: TAB_ID })
  assert.equal(typeof boom, 'function')
  boom()
  let called = 0
  const ok = registerSidebarTab({ registerTab: (d) => { called++; assert.equal(d.id, TAB_ID); return () => called-- } }, { id: TAB_ID })
  assert.equal(called, 1)
  ok()
  assert.equal(called, 0, 'disposer 必须转交 service 给的那个，注册才算可回收')
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test "test/sidebar-tab.test.js"`
Expected: FAIL，模块不存在。

- [x] **Step 3: 写实现（`MODE` 用 Task 1 填的值，只留胜出分支）**

```js
/**
 * 侧栏播放 tab 的纯构建层：seed 形状、外链认领、descriptor。
 * 全部可拿假 service 单测——装配（真 ctx）留在 _footer，这层不认识宿主。
 */
import { playerEmbed } from './views/drawer.js'

export const TAB_ID = 'dsh-baleen:player'
/** Task 1 的 P3 结论：'url' = DSH 原生右栏，'meta' = better-sidebar 底部工作台 */
export const MODE = 'url'

export function parseVideoUrl(raw) {
  let u = null
  try { u = raw instanceof URL ? raw : new URL(String(raw ?? '')) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const href = u.href
  const embed = playerEmbed(href)
  if (!embed) return null            // 含 b23.tv：抢下来只会开一个播不了的门
  return { ...embed, url: href }
}

export function videoTabSeed(url, title = '') {
  const base = { type: TAB_ID, title: title || 'Baleen 播放' }
  return MODE === 'url' ? { ...base, url } : { ...base, meta: { url, title } }
}

export function buildTabDescriptor({ seed, render, flags }) {
  const urlOf = (tab) => String(tab?.url ?? tab?.path ?? tab?.meta?.url ?? '')
  return {
    id: TAB_ID,
    title: 'Baleen 播放',
    description: '把 B 站 / YouTube 视频在侧栏里播，不跳平台',
    order: 60,
    single: false,
    dedupeKey: (tab) => TAB_ID + ':' + urlOf(tab),
    urlTarget: (url) => Boolean(flags.takeover()) && Boolean(parseVideoUrl(url)),
    component: (props) => render({ url: urlOf(props?.tab) || urlOf(seed), title: String(props?.tab?.title ?? seed?.title ?? '') })
  }
}

export function registerSidebarTab(service, descriptor) {
  const noop = () => {}
  if (!service || typeof service.registerTab !== 'function') return noop
  try {
    const disposer = service.registerTab(descriptor)
    return typeof disposer === 'function' ? disposer : noop
  } catch (e) {
    console.error('[dsh-baleen] 侧栏 tab 注册失败：' + ((e && e.message) || e))
    return noop
  }
}
```

- [x] **Step 4: 登记 PARTS 并跑通**

`tools/build-client.mjs` 的 `PARTS` 里加 `'sidebar-tab.js'`。

Run: `node --test "test/sidebar-tab.test.js" "test/build.test.js"`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/client/sidebar-tab.js tools/build-client.mjs test/sidebar-tab.test.js
git commit -m "feat: 侧栏 tab 的纯构建层——seed/认领谓词/descriptor，b23.tv 不抢、按 URL 去重"
```

---

### Task 5: 装配接线（软探测服务 + 注册 + 面板按钮回调）

**Files:**
- Modify: `src/client/_footer.txt:18`（`inject` 数组）、`src/client/_footer.txt` 的 `apply(ctx)`（约 515-561 行）
- Modify: `tools/client-loader.mjs:52`（`makeStubs` 参数）与 `:87-98`（`makeCtx` 的 target/get）
- Modify: `package.json`（若 P2 证明必须走包名注入，才加 `dsh.client.inject`；否则不动）
- Test: `test/client-boot.test.js`

**Interfaces:**
- Consumes: `registerSidebarTab / buildTabDescriptor / videoTabSeed / parseVideoUrl`（Task 4）、`PlayerTab`（Task 3）、`GET /preference` 的 `sidebar_takeover` / `sidebar_crop`（Task 2）
- Produces: 客户端导出 `sidebarTab = { available: boolean, open(url, title): boolean }`——`open()` 给抽屉按钮用，服务不可用时返回 `false`。

- [x] **Step 1: 先扩测试桩（现在的桩只认 `slots`，别的声明服务一律返回 `undefined`）**

`tools/client-loader.mjs:52` 的 `makeStubs` 与 `:87` 的 `makeCtx` 改成可注入假服务：

```js
export function makeStubs({ storage = {}, fetchImpl, services = {} } = {}) {
```
```js
  function makeCtx(declared) {
    const set = new Set(declared)
    const target = {
      get: (name) => {
        if (!set.has(name)) throw new Error(`cannot get service "${name}" without inject`)
        return name === 'slots' ? slots : services[name]
      },
      provide: () => {},
      on: () => {},
      effect: (fn) => fn(),
      slots,
      ...services
    }
```
（`loadClient(opts)` 本来就把 `opts` 透给 `makeStubs`，所以 `loadClient({ services: { betterSidebar: fake } })` 直接可用；Proxy 的 `get` 陷阱读 `t[prop]`，展开 `services` 后属性访问也拿得到。桩的语义必须与宿主一致：**没声明就抛**。）

- [x] **Step 2: 写失败的测试**

`test/client-boot.test.js` 追加（`exportsOf(s)` 取模块导出、`ex.apply(ctx)` 跑装配——这是该文件既有的写法，不是 `s.apply`）：

```js
test('没声明/拿不到 betterSidebar 时：slots 照注册、侧栏 tab 不注册、不抛', () => {
  const s = loadClient()
  const ex = exportsOf(s)
  const ctx = s.makeCtx(['slots', 'layout'])           // 故意少声明：Proxy 上取 betterSidebar 就抛
  const res = ex.apply(ctx)
  assert.ok(res.registeredSlots.length >= 3, '侧栏入口/面板/设置页必须照旧')
  assert.equal(res.sidebarTab.available, false)
  assert.equal(res.sidebarTab.open('https://www.bilibili.com/video/BV1GJ411x7h7', 'x'), false)
})

test('声明并给出 betterSidebar 时：注册发生，open() 用 Task 1 定下的 seed 形态', () => {
  const registered = []
  const opened = []
  const s = loadClient({
    services: {
      betterSidebar: {
        registerTab: (d) => { registered.push(d); return () => {} },
        openTab: (seed) => { opened.push(seed) }
      }
    }
  })
  const ex = exportsOf(s)
  const res = ex.apply(s.makeCtx(ex.inject))           // ex.inject 已含 'betterSidebar'
  assert.equal(res.sidebarTab.available, true)
  assert.equal(registered[0].id, 'dsh-baleen:player')
  res.sidebarTab.open('https://www.bilibili.com/video/BV1GJ411x7h7', '某条视频')
  assert.equal(opened[0].type, 'dsh-baleen:player')
  assert.equal('url' in opened[0], MODE === 'url', 'seed 载荷必须与 Task 1 的 MODE 一致')
  assert.equal('meta' in opened[0], MODE === 'meta')
})

test('urlTarget 认领走偏好：sidebar_takeover=false 时注册仍成功但不抢链接', async () => {
  const registered = []
  const s = loadClient({
    services: { betterSidebar: { registerTab: (d) => { registered.push(d); return () => {} }, openTab: () => {} } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pref: { sidebar_takeover: false } }) })
  })
  const ex = exportsOf(s)
  ex.apply(s.makeCtx(ex.inject))
  await Promise.resolve(); await Promise.resolve()      // 等 preferenceGet 的微任务落定
  assert.equal(typeof registered[0].urlTarget, 'function')
  assert.equal(registered[0].urlTarget(new URL('https://www.bilibili.com/video/BV1GJ411x7h7')), false)
})
```
（`MODE` 从 `src/client/sidebar-tab.js` import 进来断言，别把 `'url'`/`'meta'` 硬写进测试——那样换了分支也测不出真相。桩默认 `fetchImpl` 返回 `{ ok: true }`，所以第一条测试里 `preferenceGet` 读不到布尔，`takeover` 保持默认开，正好证明"读不到不炸"。）

- [x] **Step 3: 跑测试确认失败**

Run: `node --test "test/client-boot.test.js"`
Expected: FAIL，`res.sidebarTab` 为 `undefined`。同时确认既有的那条 `doesNotThrow(() => ex.apply(s.makeCtx(['slots'])))` 仍然绿——它是"没装 better-sidebar 不许白屏"的既有守卫。

- [x] **Step 4: 写装配（`inject` 加服务名 + 注册 + open）**

`src/client/_footer.txt:18`：

```js
    const inject = ['slots', 'layout', 'betterSidebar']
```

factory 作用域里（`function getLayout()` 之后，`:30-45` 那一带）加能力对象——放这里而不是 `apply()` 里面，是因为 `Panel`（`:86`）要直接读它，装两份状态迟早漂移：

```js
    /**
     * 侧栏播放能力（M7）。探测放在调用时：better-sidebar 可能被禁用或根本没装，
     * 面板其余功能不能因此白屏；裸读 ctx.betterSidebar 在 Proxy 上会抛，一律走 safeGet。
     */
    let takeoverOn = true     // 偏好读回来之前按默认值，与 DEFAULTS.sidebar_takeover 一致
    let cropOn = true
    const sidebarTab = {
      get available() {
        const bs = safeGet('betterSidebar')
        return Boolean(bs && typeof bs.registerTab === 'function')
      },
      open(url, title) {
        const bs = safeGet('betterSidebar')
        if (!bs || typeof bs.openTab !== 'function' || !parseVideoUrl(url)) return false
        try { bs.openTab(videoTabSeed(url, title)); return true }
        catch (e) { console.error('[dsh-baleen] 侧栏没接住这条：' + ((e && e.message) || e)); return false }
      }
    }
```

`apply(ctx)` 里，`reg('settings.section', …)` 之后、`return { registeredSlots: registered }`（`:561`）之前插入：

```js
      if (sidebarTab.available) {
        ctx.effect(() => registerSidebarTab(safeGet('betterSidebar'), buildTabDescriptor({
          seed: {},
          flags: { takeover: () => takeoverOn },
          render: ({ url, title }) => toElement(PlayerTab({ url, title, crop: cropOn }))
        })))
        // urlTarget 是同步谓词，所以偏好只能读一次缓存进布尔；读不到就保持默认开
        const prefApi = createApi({ fetch: globalThis.fetch, storage: globalThis.localStorage })
        prefApi.preferenceGet().then((r) => {
          const p = r && r.pref
          if (typeof p?.sidebar_takeover === 'boolean') takeoverOn = p.sidebar_takeover
          if (typeof p?.sidebar_crop === 'boolean') cropOn = p.sidebar_crop
        }).catch(() => {})
      }
```

返回值那一行（`:561`）改为：

```js
      return { registeredSlots: registered, sidebarTab }
```

`__test` 那份导出面（`:565-571`）保持原样——测试走 `apply()` 的返回值拿 `sidebarTab`，不必往里塞。注意 `createApi` 的实参形状照抄 `:88` 与 `:306` 的既有写法（`{ fetch, storage }`），别新造调用方式。

- [x] **Step 5: 生成 + 全量**

```bash
node tools/build-client.mjs && npm run build:check
node --test "test/*.test.js"
```
Expected: 全绿；`client-boot` 三条新测试 PASS（这组单测同时回答 P2b"没装 better-sidebar 会不会白屏"，真机摘插件那步可以不做——它要动 profile 配置，风险由 AGENTS.md 明确警告过）。

- [x] **Step 6: Commit**

```bash
git add src/client/_footer.txt client.js tools/client-loader.mjs test/client-boot.test.js
git commit -m "feat: 侧栏 tab 接线——safeGet 软探测，没装 better-sidebar 面板照旧"
```
（`package.json` 只在 P2 证明必须走包名注入时才加进这次提交；否则一个字不动。）

---

### Task 6: 抽屉「侧栏播放」按钮 + 卡片尾标改判

**Files:**
- Modify: `src/client/views/drawer.js:98`（props 解构）、`src/client/views/drawer.js:243-252`（原文段按钮组）
- Modify: `src/client/views/video.js:36-53`（`VideoCard` 尾标 + 文件头 import）
- Modify: `src/client/_footer.txt:273-292`（`Drawer({...})` 调用点传 `sidebar: sidebarTab`）
- Test: `test/views-drawer.test.js`、`test/views-video.test.js`

**Interfaces:**
- Consumes: `sidebarTab`（Task 5 的 `{ available, open(url, title) }`）、`playerEmbed(url)`
- Produces: `Drawer({ …, sidebar = null })`——`sidebar` 是 Task 5 的 `sidebarTab` 对象，`sidebar.available` 为假时**不画按钮**；`VideoCard` 尾标由 `playerEmbed(item.url)` 分支决定。

- [x] **Step 1: 写失败的测试**

`test/views-drawer.test.js` 追加（该文件已有 `item()` 夹具，默认 url 是 `https://b23.tv/x`）：

```js
const openBtns = (tree) => findAll(tree, 'bl-openbtns')[0].children
const sidebarBtn = (tree) => openBtns(tree).find((b) => text(b).includes('侧栏播放'))

test('抽屉：能内嵌 + 侧栏可用才画「侧栏播放」，两者缺一个就不画死按钮', () => {
  const embeddable = item({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })
  const yes = { available: true, open: () => true }
  assert.ok(sidebarBtn(Drawer({ item: embeddable, api: {}, sidebar: yes })), '两个条件都满足必须有按钮')
  // 侧栏不可用 / 压根没传 / 短链解析不出嵌入形态——三种情况都不许画
  for (const [label, over] of [['侧栏不可用', { sidebar: { available: false, open: () => false } }], ['没传侧栏', {}]]) {
    assert.equal(findAll(Drawer({ item: embeddable, api: {}, ...over }), 'bl-openbtns')[0].children
      .some((b) => text(b).includes('侧栏播放')), false, label)
  }
  assert.equal(findAll(Drawer({ item: item(), api: {}, sidebar: yes }), 'bl-openbtns')[0].children
    .some((b) => text(b).includes('侧栏播放')), false, 'b23.tv 解析不出嵌入形态，侧栏也播不了')
})

test('点「侧栏播放」把这条的原始 url 与标题交给侧栏，没开成要回显（视图是纯的，回显走 onDone）', () => {
  const calls = []
  const tree = Drawer({
    item: item({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {},
    sidebar: { available: true, open: (u, t) => { calls.push([u, t]); return true } }
  })
  sidebarBtn(tree).props.onClick()
  assert.deepEqual(calls, [['https://www.bilibili.com/video/BV1GJ411x7h7', 'DSH 插件怎么写']], '交给侧栏的必须是条目原 url，不是 embed 形态')

  const done = []
  const failed = Drawer({
    item: item({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }), api: {}, onDone: (r) => done.push(r.message),
    sidebar: { available: true, open: () => false }
  })
  sidebarBtn(failed).props.onClick()
  assert.match(done.join('|'), /侧栏没接住/, '点了没开成不许静默')
})
```

`test/views-video.test.js`：**替换** `:57-62` 那整条测试（`暂无内嵌播放：B 站与其它平台都只给跳转…` 连同它上面那段 M4a 注释一起删——注释说的"播放器还没定"现在已经是反话）：

```js
// 卡片尾标必须跟抽屉的能力边界说同一件事：能解析出嵌入形态的就是"抽屉里能播"，
// 解析不出的（b23.tv 短链、非视频域）才写"只能跳转"。两处相反就是谎。
test('卡片尾标按嵌入形态说真话', () => {
  const can = text(VideoView({ items: [mk({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })], filters: {} }))
  assert.match(can, /抽屉里能播/)
  assert.doesNotMatch(can, /只能跳转/)
  const cant = text(VideoView({ items: [mk({ url: 'https://b23.tv/abc' })], filters: {} }))
  assert.match(cant, /只能跳转/)
  assert.doesNotMatch(cant, /抽屉里能播/)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test "test/views-drawer.test.js" "test/views-video.test.js"`
Expected: FAIL（按钮不存在；尾标恒为"只能跳转"）。

- [x] **Step 3: 实现抽屉侧**

`src/client/views/drawer.js:98` 的解构参数只加一个 `sidebar = null`（能力对象自带 `open`，不必再多一个回调 prop）：

```js
export function Drawer({ item, api = {}, onClose, onDone, note, folders = [], collecting = false, newFolderName = '', onNewFolderName = () => {}, onOpenUrl, sidebar = null })
```

原文段（`src/client/views/drawer.js:243-252`）的 `bl-openbtns` 里追加按钮——`embed` 这个局部量已经在 `:161` 算好了，直接用它，别再解一次 URL；同时把 `:239-250` 那段"侧栏打开在面板里开不出来"的注释改口（它只对当年的**宿主原生侧栏**成立，M7 走的是 better-sidebar 的 tab）：

```js
          vnode('div', { className: 'bl-openbtns' }, [
            vnode('button', { type: 'button', onClick: () => onOpenUrl?.(link, item.id) }, ['浏览器打开']),
            item.kind === 'video' && embed && sidebar?.available
              ? vnode('button', {
                  type: 'button',
                  title: '在侧栏里播这条，不去平台',
                  onClick: () => {
                    if (!sidebar.open(item.url, item.title)) {
                      onDone?.({ message: '侧栏没接住这条——先在抽屉里播，或者去浏览器打开。' })
                    }
                  }
                }, ['侧栏播放'])
              : null
          ].filter(Boolean)),
```

`boundaryNote(item)`（`src/client/views/drawer.js:50-61`）那句"弹幕和评论区要去原站"保持不变——侧栏播的也是完整页，说法仍然成立。

- [x] **Step 4: 实现卡片侧 + 装配传参**

`src/client/views/video.js` 文件头补 import：

```js
import { playerEmbed } from './drawer.js'
```
`VideoCard` 里 49-51 行那段 M4a 注释与恒为"只能跳转"的尾标，整段换成按形态分支：

```js
    vnode('span', { className: 'bl-play' }, [playerEmbed(item.url) ? '抽屉里能播' : '只能跳转'])
```

`src/client/_footer.txt:273-292` 的 `Drawer({...})` 调用点，在 `onOpenUrl:` 那行旁边加一行（`sidebarTab` 是 Task 5 放在 factory 作用域的那个对象）：

```js
            sidebar: sidebarTab,
```
装配层不需要再包一层回调：`sidebarTab.open` 自己负责取服务、拼 seed、调 `betterSidebar.openTab`。

- [x] **Step 5: 生成 + 全量**

```bash
node tools/build-client.mjs && npm run build:check && node --test "test/*.test.js"
```
Expected: 全绿。

- [x] **Step 6: Commit**

```bash
git add src/client/views/drawer.js src/client/views/video.js src/client/_footer.txt client.js test/views-drawer.test.js test/views-video.test.js
git commit -m "fix: 卡片尾标与抽屉文案对齐（能内嵌的不再写只能跳转），新增侧栏播放按钮"
```

---

### Task 7: 设置页两个开关

**Files:**
- Modify: `src/client/views/settings.js:316-317`（`flag(...)` 那一段）
- Test: `test/views-settings.test.js`

**Interfaces:**
- Consumes: `pref.sidebar_takeover` / `pref.sidebar_crop`（Task 2）、既有的 `flag(key, label, hint, value)`（`src/client/views/settings.js:225`）
- Produces: 两个 `aria-label` 为 `sidebar_takeover` / `sidebar_crop` 的 checkbox，经现有 `PUT /preference` 提交，无新路由。

- [x] **Step 1: 写失败的测试**

`test/views-settings.test.js` 追加。该文件已有 `PREF` 夹具、`controls(node)`（按 `aria-label` 收控件）与 `byLabel(tree, label)`，`PrefsTab` 的真实签名是 `PrefsTab({ pref, themesDraft, …, onSave, readOnly, busy })`（`src/client/views/settings.js:177-179`）——只传必要 prop，草稿类全部走视图内部的 `?? ` 回落：

```js
test('偏好页有侧栏两个开关，默认开（flag 的形状是 checked: value !== false）', () => {
  const t = PrefsTab({ pref: { ...PREF, sidebar_takeover: true, sidebar_crop: true }, onSave: () => {} })
  const labels = controls(t).map((c) => c.props['aria-label'])
  assert.ok(labels.includes('sidebar_takeover'), labels.join('|'))
  assert.ok(labels.includes('sidebar_crop'), labels.join('|'))
  assert.equal(byLabel(t, 'sidebar_crop').props.checked, true)
})

test('关掉的开关画成未勾选，且 hint 里要说清"关掉会怎样"', () => {
  const t = PrefsTab({ pref: { ...PREF, sidebar_takeover: false }, onSave: () => {} })
  assert.equal(byLabel(t, 'sidebar_takeover').props.checked, false)
  assert.match(text(t), /系统浏览器/, '关掉=链接照旧去系统浏览器，这句话必须在界面上')
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test "test/views-settings.test.js"`
Expected: FAIL，找不到那两个 `aria-label`。

- [x] **Step 3: 实现**

`src/client/views/settings.js:317`（`inject_prompt` 那行）之后追加：

```js
      flag('sidebar_takeover', '会话里点 B 站 / YouTube 链接时，落进侧栏播放而不是系统浏览器', '关掉后这些链接照旧开去系统浏览器；侧栏 tab 本身还在，抽屉里的「侧栏播放」仍可用', pref?.sidebar_takeover),
      flag('sidebar_crop', '侧栏播 B 站时裁掉下面的相关推荐', '平台改版导致裁切错位、把播放控制条也遮住了，就用这个还原完整页', pref?.sidebar_crop),
```

- [x] **Step 4: 跑测试确认通过 + 全量 + 生成**

```bash
node --test "test/views-settings.test.js"
node tools/build-client.mjs && npm run build:check && node --test "test/*.test.js"
```

- [x] **Step 5: Commit**

```bash
git add src/client/views/settings.js client.js test/views-settings.test.js
git commit -m "feat: 设置页加「侧栏接管链接」「裁掉推荐区」两个开关，默认开"
```

---

### Task 8: 真机验收 + 文档同步

**Files:**
- Modify: `docs/verification.md`（M7 验收小节 + 未验表）
- Modify: `docs/superpowers/specs/2026-11-04-baleen-m7-sidebar-player-design.md`（§11 未验项按实况更新）
- Modify: `README.md` / `AGENTS.md`（若这两个开关和侧栏入口改变了用户可见用法——按"改代码同轮扫文档"执行，不许留下过期句子）
- Modify: `src/client/css.js`（按截图定 `--bl-window` / `--bl-frame` 的实际像素）

**Interfaces:**
- Consumes: 前七个任务的全部产物
- Produces: 验收记录与两个 CSS 常量的实测值

- [ ] **Step 1: 重启装配检查**

```bash
grep -n baleen ~/.dsh/profiles/desktop/cordis.patch.yml
```
条目丢了 → `dsh plugin --profile desktop add link:D:/dsh-baleen` 重新装配。**优雅关窗重启**，禁止强杀。

- [ ] **Step 2: 明暗两主题截图并定裁切值**

在侧栏 tab 里播一条 B 站视频，明、暗主题各截一张（存 `out/`，命名 `m7-<theme>-<mode>.png`）。按截图量出"播放器+标题条"的实际高度，回填 `src/client/css.js` 的 `--bl-window`（露出的高度）与 `--bl-frame`（iframe 内部视口高），要求：推荐流完全在窗口外、播放控制条不被遮。改完跑：

```bash
node tools/build-client.mjs && npm run build:check && node --test "test/css.test.js"
```

- [ ] **Step 3: 五条真机判据逐条记录**

1. 抽屉「侧栏播放」→ 容器出现、视频在容器里开播；
2. 会话里点 B 站链接 → 被认领进同一容器；`Ctrl+click` → 去系统浏览器；
3. 关掉「侧栏接管链接」并重启装配 → 外链不再被认领，但「侧栏播放」按钮仍在；
4. 关掉「裁掉推荐区」→ 完整页可下滑看到推荐流（还原路径可用）；
5. 同一视频点两次只开一个 tab，换一条视频另开一个。

- [ ] **Step 4: 未验项如实写进 verification.md**

至少包含：宿主升级后 `urlTarget` 认领顺序变化（注册先到先得）、B 站改版导致裁切错位的复发频率、分支 B（底部工作台）下"侧栏"名不副实的观感结论。验不过的写成未验，不许写成通过。

- [ ] **Step 5: 全量 + Commit**

```bash
node --test "test/*.test.js" && npm run build:check
git add docs/verification.md docs/superpowers/specs/2026-11-04-baleen-m7-sidebar-player-design.md README.md AGENTS.md src/client/css.js client.js
git commit -m "docs: M7 侧栏播放器真机验收——裁切值实测回填，未验项如实留账"
```

---

## 自审记录

- **Spec 覆盖**：§3 探针→Task 1；§5.1→Task 3；§5.2→Task 4+5；§5.3→Task 6；§8→Task 2+7；§10→各任务的 Step 1；§11→Task 8；§12/§6 的红线在 Global Constraints 与 Task 3/4 的实现里各钉了一次（侧栏无收藏、不放宽 `/open`）。
- **P2b 的处理**：spec 里写的是"真机摘掉 better-sidebar"，计划改成用 `makeCtx(['slots','layout'])` 复刻 Proxy 抛错来证明降级（Task 5 Step 2）——同等证明力，且不碰 profile 配置（AGENTS.md 明确警告动 profile 的风险）。摘插件的真机验证降为可选，未做要记进 verification.md。
- **类型一致**：`PlayerTab({ url, title, crop })`、`videoTabSeed(url, title)`、`parseVideoUrl(raw)`、`buildTabDescriptor({ seed, render, flags })`、`registerSidebarTab(service, descriptor)`、`sidebarTab = { available, open(url, title) }`、`pref.sidebar_takeover / sidebar_crop` —— 全文逐处对齐。
- **本轮评审时对着代码修掉的八处**（都是照原稿写就会白干的地方）：
  1. `urlTarget` 契约是 `(url: URL) => boolean`（`service.d.ts:217`），不是返回 descriptor 对象——实现与测试都改成布尔。
  2. 测试桩 `makeStubs/makeCtx` 目前只把 `slots` 塞进 target，声明别的真服务也拿不到值——Task 5 多加了一个"先扩桩"的步骤，并把测试写法纠正为 `exportsOf(s)` + `ex.apply(ctx)`。
  3. 客户端取偏好的真名是 `createApi({fetch,storage}).preferenceGet()`（`src/client/view-api.js:132`），不是 `getPreference`；且 `api` 只在 `Panel` 里有，`apply()` 作用域得自己 `createApi`。
  4. 抽屉的渲染点不在 `views/shell.js`，在 `src/client/_footer.txt:273-292`；`sidebarTab` 因此必须放 factory 作用域，`Panel` 才读得到。
  5. 视图是纯函数，"点了没开成"的回显不可能出现在同一次渲染里——测试改为断言 `onDone` 收到消息，实现按 `onDone` 走。
  6. `PrefsTab` 的真实签名没有 `api` / `state`（`src/client/views/settings.js:177-179`），测试改用该文件既有的 `controls` / `byLabel`。
  7. 宿主侧 PUT 测试的既有写法是 `h({url, method, ...bodyOf(x)}, fakeRes())`，`test/host-surface.test.js` 里没有 `putPref`。
  8. CSS 里 `position:absolute` 的裁切会让容器高度塌成 0；且 `test/css.test.js:82` 要求每个 `bl-` 类名都有样式——`.bl-stage-crop` 必须自带规则，不能只当标记。
- **已知脆弱点（不假装解决）**：`--bl-window/--bl-frame` 是待实测的像素对，Task 8 定值；B 站改版会再次错位，退路是 Task 7 的 `sidebar_crop` 开关；`MODE='meta'` 时"侧栏"名不副实，验收里要明说。

---

## 执行记录

**Task 5 已完成**：`_footer.txt` 的 `inject` 加服务名、factory 作用域挂 `sidebarTab`、注册段包 `ctx.effect`；测试桩加 `services` 注入口。622 tests 全绿。三处计划外修正：① `plainGet` 的形状是 `{ok, stale, data}`，偏好要从 `r.data.pref` 取（照 `r.pref` 读会永远读不到、开关静默失效）；② 既有守卫 `client.js 以 loader 格式注册` 断言 inject 数组逐字相等，加服务名必须同步改它——那条测试的作用就是逼人承认自己动了注入面；③ `sidebarTab` 用 getter 现取服务，不在 apply 里缓存，避免"装配时可用、点击时已禁用"的错位。

**Task 6 已完成（形状与计划不同，按实测与你 11-05 的拍板）**：抽屉**不放**「侧栏播放」按钮——面板在前台时 `openTab` 只进 pending 队列，点了什么都不出现，那就是 2026-10-31 撤掉的那颗死按钮的复现。于是顺带删掉两个没人调的 API：`sidebarTab`（装配层能力对象）与 `videoTabSeed`（页签由 better-sidebar 自己在认领时打开，URL 挂在 `tab.path`，我们从不构造 seed）。留下的是：`video.js` 卡片尾标按 `playerEmbed` 分支说真话、`drawer.js` 原文段的侧栏说明按能否内嵌分两支、`_footer.txt` 只保留注册与认领。两处守卫按原意更新而非放宽：`client.js 以 loader 格式注册` 的 inject 断言补上服务名；"撤掉侧栏按钮要说清原因"那条从旧句子改成 /侧栏[^。]*排队/——我先写了句不够解释的文案，是它把我抓住的。621 tests 全绿，预览页同步重出。

**Task 4 已完成**：`src/client/sidebar-tab.js` 六个断言全绿（618 tests）。三处按计划外的事实收形：① `MODE` 常量与 `meta` 分支**删掉了**——P3-D 证明换落点不换病根，留它就是死代码；② descriptor 不再收 `seed` 参数，组件只从 **`tab.path`** 取地址（实测宿主把 URL 挂在这里）；③ `urlTarget` 返回布尔（`service.d.ts:217`）。

**Task 7 已完成**：设置页新增「侧栏播放（需要 dsh-better-sidebar）」一节与两个 flag，走既有 `PUT /preference`；611 tests 全绿。偏离一处：多加了 `vnode("h4")` 分组标题并在注释里写明"没装 better-sidebar 时这两个键无实际效果"——把开关挂在「判断开关」下面会让人以为关掉就能装出功能。

**Task 2 已完成**（`e2c1ba5`）：`DEFAULTS` 两键 + `validate` 两条 + `PREF_SECTIONS` 白名单；605 tests 全绿。偏离计划两处：
- 宿主侧没另开新测试，改为把两键加进既有的 PUT 白名单循环（`test/host-surface.test.js:613-621`）并把 `sidebar_crop:'nope'` 加进既有的 400 用例——该文件的既有结构本来就覆盖"落盘 + 重载一致"，另起一条测试等于把同一件事测两遍。
- 同轮补了 `preference.example.yaml`（两个键带注释）——计划里漏了这一步，属于"改代码必须同轮扫文档"。

**Task 3 已完成**：`src/client/views/player-tab.js` + `PARTS` 登记 + `.bl-tab*`/`.bl-stage*` 样式；609 tests 全绿，`npm run build:check` 通过。偏离计划两处：
- 多补了一个预览页 `out/preview-player.html`（`tools/preview.mjs` 的 `player` 格 + `test/preview.test.js` 的 `NAMES`），三种状态（裁切默认 / 关掉裁切 / 短链播不了）同屏、明暗两块——按"新建 UI 元素定稿前给假数据 HTML 预览"的约定，这一步不该等到 Task 8 才补。预览里给的是真 URL：侧栏到底露多少、控制条会不会被遮，只能靠眼睛看。
- 测试多加一条"侧栏 tab 里没有收藏/调权重/去浏览器"（计划 §6 的红线在视图层钉住，不只写在文档里）。
