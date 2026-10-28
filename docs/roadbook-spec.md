# Roadbook 路书 — 产品 / 交互 / 开发真值表

> 本文档为 V1/V1.1 的统一真值源。早期 Cursor plan 与代码冲突时，**以本文 + 代码为准**。  
> 服务入口：`travel_app.py` → `templates/index.html`（端口 7861）。  
> 更新日期：2026-10-28。

---

## 1. 产品定位

零增本（主路径 1 次高德驾车 + POI 候选池）自驾路书 Web Demo，面向后续微信小程序。用户闭环：**生成 → 微调 → 导航 → 收藏 → 海报分享**。

主生成链路：`plan_trip_async` → `_build_fast_itinerary`（SSE 快速推出）。  
LLM/Tavily 精修为可选（`ROADBOOK_LLM_REFINE=1`），默认不增 Token。

---

## 2. 产品能力矩阵

| 能力 | 状态 | 说明 |
|------|------|------|
| 真实沿途分段 + via 地图 | 已实现 | polyline 切分途经城；DAY 与地图联动 |
| 偏好胶囊 + 预算双滑块 | 已实现 | 节奏/主题/预算档/高速/人数/油电 |
| 站点导航 / 复制 / 换一换 / 打卡 / 删 / 加站 | 已实现 | 换一换走 `city_pools`，禁跨城串味 |
| 预算明细 + 人数/油电重算 | 已实现 | `RoadbookCore.recomputeBudget` |
| 行前清单 + 勾选持久化 | 已实现 | `localStorage` via `persistTripEdits` |
| 历史收藏（最近 10 条） | 已实现 | `roadbook_v1_history` |
| Canvas 微信竖版海报 | 已实现 | 统计格/亮点/每日锚点/必吃/预算；支持 hero 图 |
| 高铁 + 到站租车（12306 MCP） | 已实现 | `travel_mode=hsr_rental`；MCP 失败走 `rail_hsr` 静态兜底 |
| 手机预览 + Tab + 底坞 | 已实现 | `phone-preview` → density `wx` |
| PlatformBridge 三端桥 | 已实现 | desktop / mobile / wx-sim |
| 三密度 DayN + RB 按钮族 | 已实现 | `data-density=desktop\|compact\|wx` |
| frost 磨砂 + WeatherFX 粒子 | 已实现 | **禁止**父级 `clip-path` |
| fit / pitfalls / 锚点·可选·郊县 / 小红书 | 已实现 | V1.1 叙事 |
| chat-edit / undo | 已实现 | 规则引擎为主；改途经可能 replan 高德 |
| 换一换 flip 动画 | **未实现** | 非 P0 |
| 统一 `RoadbookStore` 模块 | **未实现** | 等价：Core + UI 状态 |
| 独立「地图与必吃」Tab | **未实现** | 有意合并到「避坑 & 准备」 |
| 自动化测试套件 | 部分 | 见 `docs/test-report.md` |
| `itinerary.html` 与 index 同步 | **遗留** | 打印页低优；主站用 index + print CSS |

---

## 3. 预算与费用公式（真值）

三档**日均区间**（每人每天，非旧文档的固定 300/600/1200）：

| 档位 | 日均区间 | 说明 |
|------|----------|------|
| economy 经济省钱 | ¥150~260 | 快捷连锁拼房、小吃、免票优先 |
| comfort 舒适口碑 | ¥260~420 | 全季/亚朵级、必吃榜、核心景区含票 |
| premium 品质度假 | ¥450~780 | 景观美宿、特色大餐、含索道 |

车费（`RoadbookCore`）：

- 油车：`0.58 元/km`；电车：`0.18 元/km`
- 高速过路费：高速优先 `0.42 元/km`；少走高速 `0`

表单阶段用 `estimateFormBudgetRange`；结果阶段用真实里程 `recomputeBudget`。

**高铁 + 租车**（`prefs.travel_mode === "hsr_rental"`）：

- 规划完成后 `rail_hsr.attach_hsr_rental_to_trip` 写入 `trip.hsr`（班次 Top3、`booking_url`、租车天数/日租金）。选票会对照途经城市：用出发站到该城高铁站的车次，判断直达班次是否经停，经停更多的排前面；途经超过 3 座时核对首、中、尾。对不上的城在票卡上写明「到站后开车去」。
- 预算追加 `budget.hsr_tickets`、`budget.car_rental`；当地油费/过路费按 `local_drive_km`（约 `days×55km`）估算，不含跨城自驾段。
- `reshape_trip_for_hsr_local`：去掉 `kind=transit` 跨城赶路段，D1 为「乘高铁抵达·取车」，其余日以 **目的地** 为 `stay_city`；地图 `hsr_local_map` 只画高铁虚线（起终点）+ 当地 `polyline`；兴趣途经保留在 `plan_via_cities` 供后台选票（经停说明在 **高铁票卡** `via_note`），**途经栏 UI 仅展示起终点**。
- 12306：MCP 包 `12306-mcp`（`npx -y 12306-mcp`），超时 14s 或 `ROADBOOK_HSR_MCP=0` 时仅用参考班次；余票以官网为准。
- 优先示范城市对（国铁暑运/国庆报道）：北京—上海、广州—长沙、成都—西安、北京—西安、北京—成都 等，见 `rail_hsr.HSR_PRIORITY_PAIRS`。

---

## 4. 交互与信息架构

### 4.1 双轴（不变）

- **横向**：`DayBar` / `DayChip` 日切（一屏露出约 2.5～4.5 张，随密度变）
- **竖向**：`DayHero` → `StopList` 时间轴  
- **禁止**整页横向 Swiper（与微信侧滑返回冲突）

### 4.2 三密度

| density | 触发 | DayChip | 触控 |
|---------|------|---------|------|
| desktop | 宽屏桌面 | 148×108 | `--touch-min: 36px` |
| compact | ≤980 或 mobile-web | 132×98 | 44px |
| wx | 真小程序 / phone-preview 仿真 | 120×90 | 44px；序号 ≥44 |

由 `PlatformBridge.applyDensity()` 写入 `body[data-density]`。

**页面宽度**：`desktop` / `compact` 随浏览器窗口伸缩（`max-width: min(1320px, 95vw)`）；仅 `wx` 与「手机预览」用 **430px** 居中仿真壳。桌面拖窄窗口不应锁死 430px。

### 4.3 移动端 Tab（现网）

`每日行程 | 费用预算 | 避坑 & 准备`  
准备 Tab 内聚合：行前清单 + 避坑/住宿 + 必吃。封面地图在 Cover，不单独 Tab。

### 4.4 DayN 视觉硬约束

- frost：`body[data-wx-veil=frost]` + `.wx-fx-base::before` 左侧 mask 磨砂
- WeatherFX：`.wx-canvas` 粒子挂在 `.wx-fx`
- **父级 `.day-hero` 禁止 `clip-path`**（会切断 backdrop-filter 与 Canvas）
- 圆角：`overflow:hidden` + 子层 `border-radius: inherit`
- 栅格 token：`--rail-w`（36/32/40）、`--rail-gap`（10/8）；`free-slot`/`add-stop` 左缘对齐 `stop-body`

### 4.5 沿途途经栏（ViaBar）

- 结构：`出发 ─[里程]─ ①城市 ─[里程]─ ②城市 ─[里程]─ 抵达`；主轴线横贯首末端点，里程药丸取自 `days_plan` 中 `kind=transit` 的 `from_city→to_city`，无数据时只画线
- 0 途经：起终点分居两端，中间一段直达里程；1 途经：不可排序，提示「点城市看当天 · × 跳过」
- 交互：点城市 / 里程 → 定位当天；× → 卡片立即半透明 + 删除线，请求期间锁定其它途经操作；拖拽排序与删除后后端按剩余城市逐段重算高德真实里程，**不自动补城**
- 单段车程 > 节奏日上限 × 1.3（450/600/750 km）→ 琥珀色 + ⚠，后端回复附「可加途经城分担」提醒
- 适配：compact/wx 隐藏车时只留 km、终点列 52px、卡片向两侧路段下方出血 18px；430px 壳内 2 个途经城不滚动，更多时边缘渐隐提示横滑

### 4.6 触控热区

compact/wx 下所有可点元素有效热区 ≥ 32px（主按钮 ≥ `--touch-min` 44px）：视觉不变，用透明 `::before` 外扩；横向相邻胶囊只纵向扩。

### 4.7 RB 按钮家族

`rb-btn`（实心 CTA）、`rb-btn-ghost`（描边，兼容 `ghost-btn`/`print-btn`）、`rb-pill`/`drive-pill`、`rb-chip`/`pref-chip`、`stop-act`（行内动作）。`.brief-confirm[hidden]` 必须 `display: none`，否则 `.rb-btn` 的 `inline-flex` 会盖过浏览器对 `hidden` 的默认隐藏，改路书对话里会露出「确定，写回需求描述」。

### 4.8 悬浮副驾驶

有路书后，改路书的主入口是底部 `#appDock`，不是右栏 `#copilotPanel`。

- 底栏：`#dockHint` 写入 `copilotPrompt`（`chat_log` 最后一条非用户回复；没有则用开场句）。`#dockSave` 收藏，`#dockPoster` 海报。`#dockHistory` 隐藏。
- 点 `#dockChatOpen`，或「对话改这天」「加途经城」，调用 `openDockConversation`。宽屏、窄屏都 `RoadbookBrief.open("edit")`，打开 `#chatSheetBackdrop`。再点底栏左侧且没有预填时收起。
- 对话区在底坞上方，同宽。改路书时遮罩透明、不做整页模糊，底坞 `z-index` 高于遮罩，所以收藏和海报仍可点。
- 记录写进 `#chatLog` 与 `#chatLogMobile`（`sheetMode === "brief"` 时不覆盖手机记录，避免冲掉「说清需求」）。快捷句同理。正文经 `escAttr` 后再插入，避免回复里的 `<` 拆掉标记。
- 改完若带 `focus_day`：对话区还开着时不滚动页面。点「看 DAY N」先 `closeEditSheet()`，再 `focusAndFlashDay`。
- 「说清需求」仍是同一张抽屉的 `brief` 模式，只在生成被拦住时出现。`#chatSendMobile` 上有两个监听：`brief` 走 `brief-chat.js` 的 `submit`，其它模式走 `sendChatEdit`。
- 右栏 `#chatInput` 仍绑着 `sendChatEdit`，窄屏该面板 `display: none`。

### 4.9 行前清单与按天筛选

- `#preTripBar` 在封面 `#cover` 之下、逐日行程之上。有清单才显示，默认收起（`#preTripDrawer` 带 `hidden`）。勾选与右栏 `#checklistBox` 同一份数据。
- 避坑、住宿、必吃条目带 `day` 或 `scope=all`。`#dayBar` 选中某一天时，`filterRailItems` 只保留 `day` 数字相同的条目，全程条目不混进某一天。

---

## 5. 开发架构

### 5.1 API（`travel_app.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/plan` | SSE 流式生成 |
| POST | `/api/plan/json` | 一次性 JSON（小程序友好） |
| POST | `/api/chat-edit` | 对话微调 |
| POST | `/api/via-reorder` | 拖拽重排途经：`{ trip, via_cities }`（含起终点）→ 重建日程 |
| POST | `/api/image-tones` | 封面取色 → 动态配色（见下） |

**`/api/plan/json` 响应**：`{ "ok": true, "trip": { ...路书 } }`（路书字段在 `trip` 内，非顶层）。

**`/api/image-tones`**：请求 `{ "urls": ["https://…"] }`；响应 `{ "https://…": { "dominant", "inverse", "inverseDeep" } }`（URL 为键）。

### 5.2 前端分层

```
roadbook-ui.js     DOM 渲染、事件、SSE、本地状态
RoadbookCore       预算/换一换/无 DOM（可搬小程序）
PlatformBridge     导航/小红书/剪贴板/存储/密度
weather-fx.js      Canvas 天气粒子
```

状态键：`roadbook_v1_history`、`roadbook_v1_edits`（含 trip 快照 + checklist `checked`；**刷新页自动恢复**上次 `edits` 中的路书）。无名为 `RoadbookStore` 的模块。

前端突变协调：`mutationEpoch` 丢弃过期 SSE / chat-edit / via-reorder 响应；规划进行中禁止对话与途经拖拽；chat 失败回滚 `chat_log`。

### 5.3 chat-edit 成本说明

默认规则引擎改天数/节奏/主题/预算；**改起终点或途经城**可能触发高德 replan（非 LLM 主路径）。产品话术勿写「绝对零增本」。

---

## 6. 文档矛盾消解记录

| # | 旧文档说法 | 真值 |
|---|------------|------|
| 1 | 预算档 ¥300/600/1200/天 | 日均区间 150~260 / 260~420 / 450~780 |
| 2 | 油费统一 0.65/km | 油 0.58 / 电 0.18；高速 toll 0.42 |
| 3 | Tab「地图与必吃」 | 现网：行程 / 预算 / 避坑&准备 |
| 4 | Tavily + qwen 主合成 | fast_itinerary 主路径；LLM 可选 |
| 5 | RoadbookStore | Core + UI 状态 |
| 6 | 换一换 flip 动画 | 逻辑有、动画无 |
| 7 | clip-path 修圆角 | 已废弃；保 frost |
| 8 | rail-gap 12px | CSS `--rail-gap: 10px`（紧凑 8） |
| 9 | 对话绝对零增本 | replan 可能调高德 |
| 10 | itinerary.html 主页面 | 遗留；主站 index |
| 11 | 宽屏副驾驶只在右栏，窄屏才开底坞 | 有路书后底坞悬浮对话是改路书入口；右栏是同一份记录的宽屏副本 |
| 12 | 深色底坞用冷灰实底 | 暖色毛玻璃：浅色暖白、深色暖棕，`blur(28px)` |

---

## 7. 关键文件

| 角色 | 路径 |
|------|------|
| 后端编排 | `trip_planner.py` |
| HTTP 服务 | `travel_app.py` |
| 页面壳 | `templates/index.html` |
| 样式 | `static/css/roadbook.css` |
| UI | `static/js/roadbook-ui.js` |
| 说清需求 | `static/js/brief-chat.js` |
| Core | `static/js/roadbook-core.js` |
| Bridge | `static/js/platform-bridge.js` |
| 天气 FX | `static/js/weather-fx.js` |
| 打印遗留 | `templates/itinerary.html` |

---

## 8. 测试

见同目录 [`test-report.md`](test-report.md)（API smoke + 浏览器 T1–T10）。
