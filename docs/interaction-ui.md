# Roadbook 交互与 UI

只读 `templates/index.html` 与 `static/css/roadbook.css` 里真实存在的表面。分享页是首页的 `share_mode`，不是单独模板。生成后的逐日卡片、途经条、预算和清单由脚本写入下列容器，类名以样式表和渲染所用类为准。

主编辑页包在 `.page` 里。

## 1. 信息架构

### 生成前一屏

顶栏 `.shell`：品牌 `.brand`、标题、副文案 `.sub`。右侧 `#userAvatar`（登录后才显示）、`#openSettings`。

表单在 `#planFormBody`：

- 路线 `.route-fields`：`#origin`、`#swapCities`、`#destination`、`#days`、`#startDate`
- 偏好摘要 `#prefSummaryToggle` / `#prefSummaryText`。明细 `#prefBlock` 默认 `hidden`，内含节奏、主题、档位、出行方式、高速偏好五组 `.pref-row[data-pref]`
- 预算卡 `.budget-config-card`：`#budgetRangeText`、`#budgetMinInput`、`#budgetMaxInput`、`#budgetTierBreakdown`、`#budgetMinRange`、`#budgetMaxRange`、`#bMinLbl`、`#bMaxLbl`、`#formPaxSeg`、`#formEnergySeg`
- 需求 `#query`。示例在 `.examples`（无独立 id）
- 行动区 `.actions`：`#go`、`#status`

此时 `#planSummary` 带 `hidden`，`#result` 带 `hidden`。底坞 `#appDock` 在 `body` 没有 `has-trip` 时不显示。

### 生成后第一屏

`body` 加上 `has-trip`，`.shell` 加上 `form-collapsed`：

- `#planSummary` / `#planSummaryText` 露出，文案是「出发 → 到达 · 天数 · 日期 · 偏好一行」；动作文案是「改需求」
- `#planFormBody`、`.sub`、`#prefSummaryToggle` 收起
- `#go` 仍留在表单外面，文案改为「重新生成」，旁边仍是 `#status`

结果区 `#result` 打开。第一屏是封面 `#cover`：

- `#coverPhoto`、`#chinaMap`、`.cover-shade`、`.cover-copy`
- `#title`、`#coverRoute`（`#originText`、`#destText`）、`#highlight`、`#coverLeg`
- 四格 `.stats`：`#statDays`、`#statDistance` / `#statDistanceSrc`、`#statDrive` / `#statDriveSrc`、`#statBudget` / `#statBudgetSrc`

封面下按条件出现 `#hsrBox`（高铁+租车）。接着是按天筛选 `#dayBar` 和途经 `#via`。窄屏或手机预览才显示 `#mobileTabs`（每日行程 / 费用预算 / 避坑 & 准备）。

### 逐日

工作台 `.workbench` 左栏 `.itinerary-panel`，标题下容器 `#daysList`。

每一天是 `.day-block[data-day]`：上为 `.day-hero`（`.day-no`、标题、`.day-play-line`、`.day-summary`、`.drive-bar`），下为站点 `.stop-list`。站点卡 `.stop-card`，留白行 `.free-slot`，当天交通备注 `.local-transit`。非分享页每天底部有 `.add-stop`。

`#dayBar` 里的 `.day-chip[data-day]` 用来只看某一天；空 `data-day` 是「全部」。

### 右栏

`.rail` 自上而下：

| 区块 | 关键 id | 窄屏归入 |
| --- | --- | --- |
| 路书副驾驶 `.copilot-panel` | `#copilotPanel`、`#undoBtn`、`#chatLog`、`#quickChips`、`#chatInput`、`#chatSend` | 窄屏整块隐藏，改走底坞抽屉 |
| 自驾预算 | `#budgetBox` | `#mobileTabs` 的 budget |
| 行前检查清单 | `#checklistBox` | prep |
| 避坑和住宿 | `#tips`、`#hotels` | prep |
| 必吃 | `#foods` | prep |

分享页用 CSS 关掉 `.copilot-panel`。宽屏右栏仍渲染同一份记录；`max-width: 900px`、`data-density=compact|wx`、`.phone-preview` 时右栏副驾驶不显示。有路书之后，改路书的输入在底部悬浮对话里，不在右栏。

### 底坞

`#appDock`，只在非分享页、且 `body.has-trip` 时显示。从左到右：`#dockChatOpen`（里面 `#dockHint` 显示副驾驶最近一句，不是按钮名「改路书」）、`#dockSave`「收藏」、`#dockPoster`「海报」（`.primary`）。`#dockHistory` 仍在节点里，但是隐藏的。滚动自动收起目前关闭（`autoHideEnabled` 恒为 false）；聚焦或触碰时仍会加 `.is-pinned`。

点 `#dockChatOpen`，宽屏和窄屏都打开 `#chatSheetBackdrop` / `.chat-sheet`，模式为「改这条路书」。对话区贴在底坞上方，宽度与底坞对齐，底坞保持可见。里面有 `#undoBtnMobile`、`#closeChatSheet`、`#chatLogMobile`、`#quickChipsMobile`、`#chatInputMobile`、`#chatSendMobile`。有路书后 `.sheet-modes`（`#sheetModeBrief` / `#sheetModeEdit`）隐藏。生成前句子不完整时，同一张抽屉以「说清需求」居中打开，确认按钮是 `#briefConfirm`；这时才出现模式切换。再点左侧提示会收起已打开的改路书对话。

### 设置

`#settingsDrawer` / `.settings-sheet`，默认 `aria-hidden`，加上 `.open` 才显示。

- `#closeSettings`
- `#userAvatarLarge`、`#authUserChip`（登录后）
- `.appearance-switch`：`[data-lang-btn]`、`[data-theme-btn]`
- `#togglePhone`、`#openHistory`、`#openFeedback`、`#authLogout`（登录后才去掉 `hidden`）

历史是另一张抽屉 `#historyDrawer`：`#historyList`、`#closeHistory`。从设置的 `#openHistory` 进入，打开时会关掉设置。

意见反馈不在设置抽屉里，是 `#feedbackSheet`（`.auth-sheet`）：`#feedbackTitle`、`#feedbackClose`、`#feedbackCats`、`#feedbackText`、`#feedbackSend`、`#feedbackStatus`。页面左下还有 `#openFeedbackMobile`。

### 海报

`#posterModal`，加上 `.open` 才显示。里面 `#posterShareNote`、`#posterCanvas`、`#downloadPoster`、`#copyShareLink`（初始 `disabled`）、`#closePoster`。入口是底坞 `#dockPoster`。分享页没有底坞，因此没有这个入口，弹层节点仍在页面里。

### 分享页

`body.share-mode.phone-preview`。`.shell.share-shell` 换成只读头：分享横幅 `.share-banner`，`#shareSave`、`#shareFork`、`#shareMakeOwn`、`#shareStatus`。

表单不渲染。起终点等输入放在一段 `hidden` 里，供脚本读：`#origin`、`#destination`、`#days`、`#startDate`、`#query`、`#go`、`#status`。`#result` 直接可见。没有 `#appDock`。副驾驶和对话抽屉被 CSS 关掉。设置里另有一段 `hidden` 的 `#prefBlock`，只为分享页补齐偏好控件 id（`#budgetMinInput` 等），用户看不到。

## 2. 主任务交互

### 生成

1. 填 `#origin`、`#destination`、`#days`、`#startDate`，或点 `.examples` 写入示例并切换出行方式芯片。
2. 偏好默认收在 `#prefSummaryToggle` 后面。没手改过 `#query` 时，偏好会回写成一句需求；手改过 `#query` 后不再覆盖这句话。
3. `#go` 或在 `#query` 里按 Enter。需求缺出发、到达、天数或含糊时，不直接请求，改为打开对话抽屉的「说清需求」；补全并点 `#briefConfirm` 后写回 `#query`。字段和自动句已经够用时，直接 `POST /api/plan`。
4. 请求期间 `#go` 禁用，`#status` 报阶段，`#daysList` 等换成 shimmer。流式结果写入 `#result`。
5. 成功后收起表单，滚到 `#cover`，底坞出现。再点 `#go` 是整份重跑，不是微调。

### 改偏好

生成前：点 `#prefSummaryToggle` 展开 `#prefBlock`。`.pref-chip` 单选；档位或高速变化会重算预算区间；`#formPaxSeg`、`#formEnergySeg`、上下限滑条和数字框改人数、能源和金额。摘要 `#prefSummaryText` 只保留五个短词（节奏、主题、档位、出行方式、高速），不含具体金额。

生成后：偏好摘要随表单一起收起。要点 `#planSummary`（「改需求」）才重新看到表单和「改偏好」。改完要点「重新生成」才会进新路书。对话快捷句里也有「节奏调轻松」「主题改烟火美食」，那条走的是改路线，不是重开偏好表。

### 改路线

三条都在用，粒度不同：

- **对话。** 有路书时在悬浮对话里改：`#chatInputMobile` + `#chatSendMobile`，或 `#quickChipsMobile`。底栏 `#dockHint` 只显示最近一句，点开才进入输入。`#undoBtn` / `#undoBtnMobile` 回退。没有路书时，同一句会写进 `#query` 并走生成；缺信息则打开「说清需求」。宽屏右栏 `#chatInput` 仍绑定同一条 `sendChatEdit`，主路径不引导用户去那里。
- **途经条。** `#via` 渲染 `.via-route`。途经城可拖 `.via-mid-handle` 排序，`.via-mid-remove` 跳过一座城，`.via-add-btn` 把「中间加个」放进悬浮对话。点带 `data-via-day` 的站会落到对应天。
- **当天。** `.day-hero` 上「对话改这天」把「Day N 换成」放进悬浮对话；「导航今日全程」另走导航。站点 `.stop-act` 做导航、复制、小红书等；`.stop-remove` 删一站；`.add-stop` 从备选加一站；`.stop-idx` 可勾完成。改完若回复带「看 DAY N」，点它会先收起悬浮对话再滚到该天。对话还开着时，不会自动把页面滚到那一天。

整份推倒重来用收起态里的「重新生成」，或先「改需求」再生成。

### 出海报

有路书时点 `#dockPoster`。`#posterModal` 打开，画布是 `#posterCanvas`。打开时会写公开链接：写成后 `#posterShareNote` 改为可扫码或复制，`#copyShareLink` 可点；失败则按钮保持不可用。`#downloadPoster` 下载 PNG。`#closePoster` 或点遮罩关闭。分享页没有这个按钮。

## 3. 组件清单

只列当前主路径会画出来的类。隐藏条见第 5 节。

### 按钮

- `.rb-btn`（含 `#go`、底坞 `.primary`）：主行动，实心胶囊，用于生成、下载、分享收藏。
- `.rb-btn-ghost` / `.ghost-btn`：描边胶囊，用于设置、示例、关闭、打印类次动作。`.examples button` 共用这套。
- `.swap-btn`：圆形，交换出发地和目的地。
- `.undo-btn`：副驾驶和抽屉上的撤销、收起、关闭。
- `.copilot-form button`：发送微调，实心小胶囊。
- `.stop-act`：站点底部的一行小动作；`.primary` 是主操作，`.xhs` 是小红书色。
- `.add-stop`：虚线通栏，从备选库加一站。
- `.via-add-btn`：途经条上加一座城。
- `.via-mid-remove`：从途经条去掉一座城。
- `.stop-remove`：从某一天去掉一站。
- `.drive-pill.action`：日封面上的导航、对话改这天。
- `.bento-mini-btn`：清单标题旁的小操作。
- `.feedback-fab`：页面左下角打开反馈。
- `.auth-close`：反馈层的关闭叉。
- `.sheet-modes button`：抽屉顶部「说清需求 / 改这条路书」。
- `.mobile-tabs button`：窄屏在行程、预算、准备之间切换。
- `.appearance-switch button`：中 / EN、浅色 / 深色；按下用 `aria-pressed`。

### 芯片

- `.pref-chip`（样式与 `.rb-chip` 同一套）：偏好单选；`.active` 用主色容器底。
- `.mini-seg button`：人数、能源、预算里的分段；`.active` 实心主色。
- `.day-chip`：按天筛选，可带图；`.active` 为当前天。
- `.quick-chip`：副驾驶快捷句，点一下就发送。
- `.via-mid-chip`：途经城节点，可点到当天。
- `.via-leg-pill`：两城之间的里程胶囊；过长段带警告态。
- `.drive-pill` / `.rb-pill`：日封面上的驾驶、夜宿、当天类型，只读。
- `.stop-tag`：站点上的短标签。
- `.prio-badge`：锚点或可选；`.county-badge` 标郊县。
- `.hsr-badge`：高铁卡上的状态胶囊。
- `.chat-diff-tag`：对话回复里列出改了什么。
- `.gauge-pill`：预算相对区间的 fit / under / over。
- `.auth-user-chip`：设置里显示掩码手机号。

### 卡片

- `.shell`：生成前的整页表单面。
- `.panel`：右栏和逐日区的白卡片；`.copilot-panel` 是带主色淡边的副驾驶卡。
- `.budget-config-card`：生成前的人均预算区间。
- `.budget-hero-card`：生成后预算总览；明细是 `.budget-item-card`。
- `.stop-card` / `.stop-body`：一天里的一站；`.is-anchor` 锚点，`.is-optional` 可砍，`.done` 划掉。
- `.free-slot`：当天留白，不是景点卡。
- `.hsr-card`：高铁班次和到站租车；`.hsr-train-row` 是一班车。
- `.pitfall-card`：避坑一条（坑 / 原因 / 解法）。
- `.quiet-item`：必吃、住宿的静音列表行。
- `.bento-tile`：行前清单的一格，可勾选。
- `.history-item`：历史路书夹里的一条。
- `.login-card`：登录表单卡片。

### 封面

- `.cover`：左文案、右路线图、底四格统计。
- `.cover-photo`：底图。`#chinaMap` 叠路线。
- `.cover-shade`：左侧压暗，保证字可读。
- `.cover-copy` / `.eyebrow` / `.swatch`：品牌眉题。
- `.cover-route`：出发与到达。
- `.lede`：卖点；生成后 `.first-glance` 收成几句必知。
- `.cover-leg`：当前一段的日序、路径和里程。
- `.stats` / `.stat`：天数、里程、驾驶、人均。

### 日卡片

- `.day-bar`：横向日筛选条的容器。
- `.day-block`：一天的整块，块与块之间用 `--day-gap`。
- `.day-hero`：当天横幅；有图时 `.has-photo`，字压在 `.day-hero-veil` 上。
- `.day-hero-copy`、`.day-no`、`.day-play-line`、`.day-summary`、`.drive-bar`、`.day-wx`：标题、今天保什么、天气胶囊。
- `.day-block.flash-focus`：从对话跳到某一天时闪一下。

### 抽屉

- `.drawer` + `.drawer-sheet`：设置和历史，从底部升起；`.open` 才显示。`.settings-sheet` 是设置的网格排版。
- `.chat-sheet-backdrop` + `.chat-sheet`：有路书时是贴在底坞上方的副驾驶对话；没路书、需要补需求时是居中的「说清需求」。`.sheet-handle` 是顶部拖条。改路书时遮罩不模糊整页，好让玻璃能透出后面的路书；说清需求仍用半透明遮罩。
- `.poster-modal` + `.poster-sheet`：海报，同抽屉的开关方式。
- `.auth-sheet` + `.auth-panel`：意见反馈。

### 底坞

- `.app-dock`：底部居中宽胶囊，一条暖色毛玻璃（`backdrop-filter: blur(28px)`）。浅色底是暖白透明，深色是暖棕透明，不是冷灰实底。左侧提示不再单独做一层模糊，避免把整条玻璃盖死。
- `.dock-chat-trigger` / `#dockHint`：左侧弹性区域，看起来像输入条，实际是按钮，文案是副驾驶最近一句。
- `.app-dock button.primary`：右侧「海报」，走主色实心。「收藏」是同一条上的文字按钮。
- 有路书且对话打开时，`.chat-sheet` 与底坞同宽，圆角，坐在底坞上方约 8px。深色玻璃大约 58% 不透明度，能看见底下的地图。

途经条 `.via-route` 是封面和逐日之间的横向轨道（`.via-stop`、`.via-leg`、`.via-mid-lane`），不是底坞。

## 4. 视觉语言

字体只有一条 token：`--font-ui: "Outfit", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", sans-serif`。Outfit 用本地 `woff2`（拉丁与拉丁扩展），中文回落到 Noto Sans SC。`body` 用它。字号阶梯是 `--fs-display`、`--fs-cover-title`、`--fs-hero-num`、`--fs-h3`、`--fs-day-title`、`--fs-title`、`--fs-body`、`--fs-caption`、`--fs-micro`。圆角是 `--r-xl` 24、`--r-lg` 18、`--r-md` 14、`--r-sm` 10。封面大标题另写了 `clamp(30px, 3vw, 44px)`，不走 `--fs-cover-title`。

主题写在 `html` 的 `data-theme`。浅色是 `:root`，`color-scheme: light`。深色是 `html[data-theme="dark"]`，`color-scheme: dark`。下面只列样式表里写明的色值。

### 浅色表面（`:root`）

| Token | 值 | 用在 |
| --- | --- | --- |
| `--md-surface` | `#f4f2ee` | 页面底 |
| `--md-surface-dim` | `#e8e6e1` | 页面底渐变末端 |
| `--md-surface-container` | `#f7f6f3` | 输入、摘要、次级块 |
| `--md-surface-container-high` | `#ffffff` | 更高一层的小标签底 |
| `--rb-elevated` | `#ffffff` | 壳、面板、卡片 |
| `--rb-sheet` | `rgba(255,255,255,.9)` | 已定义；悬浮对话不用它，改路书玻璃是 `rgba(255,250,245,.62)` |
| `--rb-field` | 同 `--md-surface-container` | 抽屉输入 |
| `--rb-poster` | `#f6f3ee` | 海报画布底 |
| `--md-on-surface` | `#1a1816` | 主字 |
| `--md-on-surface-variant` | `#6a6560` | 次字、标签 |
| `--md-outline` | `#b7b1a8` | 虚线、弱图标 |
| `--md-outline-variant` | `#e6e1da` | 卡片和输入描边 |
| `--shadow` | 浅暖阴影 | 壳、卡片 |

页面底是 `--md-surface` 到 `--md-surface-dim` 的竖向渐变。

### 深色表面（`html[data-theme=dark]` 覆盖）

| Token | 值 |
| --- | --- |
| `--md-surface` | `#0e0c0a` |
| `--md-surface-dim` | `#090807` |
| `--md-surface-container` | `#1a1714` |
| `--md-surface-container-high` | `#24211d` |
| `--rb-elevated` | `#1c1916` |
| `--rb-sheet` | `rgba(28,25,22,.94)`（已定义；悬浮对话实际是 `rgba(36,26,18,.58)`） |
| `--rb-field` | `#141210` |
| `--rb-poster` | `#141210` |
| `--md-on-surface` | `#fff6ee` |
| `--md-on-surface-variant` | `#cbb8a8` |
| `--md-outline` | `#8a7568` |
| `--md-outline-variant` | `#3a312b` |
| `--shadow` | 更深的黑阴影 |

未在深色块里重写的 token 继续用 `:root`，包括 `--font-ui`、全部 `--fs-*`、圆角、`--rb-success`、`--rb-drive-*`、`--rb-track`。

### 强调色

浅色主色 `--md-primary: #ef5a28`，字 `--md-on-primary: #ffffff`，容器 `--md-primary-container: #ffe8dc` / `--md-on-primary-container: #6a2408`。深色主色改为 `#ff8a4c`，字 `#2a1006`，容器 `#5c2a12` / `#ffe4d4`。

第二色 `--md-secondary` 浅 `#0e8fbf`、深 `#7ec8f0`，配 `--md-secondary-container` 与 `--md-on-secondary-container`。第三色 `--md-tertiary` 浅 `#c8890a`、深 `#ffd15c`。

封面氛围三色只在 token 里，浅色 `--md-hero-start #ff8a3d`、`--md-hero-mid #ffb703`、`--md-hero-end #4eb4e8`；深色改为 `#1a0e08`、`#3a1c0c`、`#0e2430`。登录背景另写了固定橙、蓝、黄径向渐变，不引用这三枚 token。

路书语义色：`--rb-success #16a34a`（深色不改色值，只改容器）。锚点 `--rb-anchor`，小红书 `--rb-xhs` 一族，警告 `--rb-warn-*`，危险 `--rb-danger`。浅色主色叠在白卡片上是 `--rb-tint`（6%）和 `--rb-tint-strong`（11%）；深色改为 14% 和 24%。驾驶胶囊的 `--rb-drive-fill`、`--rb-drive-border`、`--rb-drive-text` 只在浅色定义。

预算总览卡 `.budget-hero-card` 和封面统计条用了写死的暖黑渐变与白字，不跟随 `--md-surface`。

## 5. 已隐藏或退出主路径、仍留在 DOM 的控件

这些节点还在，脚本仍可能写入或绑定点击，但主路径不把它们当入口。

- `#openBriefChat`（`.brief-open.hidden`，`tabindex="-1"`，`aria-hidden`）：「信息不全就点这里说」。点击仍会打开 brief 抽屉，但没有脚本去掉 `hidden`。不完整需求改为由生成拦截直接开抽屉。
- `#openBriefFromCopilot`：副驾驶标题旁的「重写需求」，同样 `hidden` + `aria-hidden`，点击逻辑还在。
- `#preTripBar` 及 `#preTripToggle`、`#preTripBadge`、`#preTripPending`、`#preTripFill`、`#preTripArrow`、`#preTripDrawer`、`#checklistTopBox`：封面和按天之间的行前条。渲染函数每次都加上 `hidden`。清单只留在右栏 `#checklistBox`。打印样式仍单独隐藏这条。
- `#fitStrip`：适合谁 / 慎选。渲染时写入内容，随即 `hidden`。注释写明封面第四句已承担「必知」。
- `#dockHistory`：底坞「历史」，`hidden` + `aria-hidden`，点击仍打开 `#historyDrawer`。看得见的入口是设置里的 `#openHistory`。底坞「收藏」写入的是同一本历史夹。
- `.toolbar` 里的「打印行程单」：整段 `hidden` + `aria-hidden`。打印样式会再藏掉壳、日条、底坞、抽屉和行前条。
- `#sheetModeBrief`：节点常在。`body.has-trip` 后 `display: none`。生成前的补问仍用同一张 `#chatSheetBackdrop`。
- 分享页 `#shareFork` 显示「据此修改」，把这一版复制到本机草稿。
- `#authLogout` 保持隐藏。
