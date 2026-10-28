# 把一句口语收成能发给同伴的路书

Roadbook 做的事很窄：把一句口语收成几天自驾，或高铁到站再租车的路书。生成后先看封面四句，再按天看取舍；改完把这一版用真链接发给同伴。

代码在 [github.com/devgxy/roadbook](https://github.com/devgxy/roadbook)。下面先讲为什么这样设计，再对到文件和函数。

## 一、要定下来的是一版路，不是一篇攻略

出发前要同时说清五件事：去哪、怎么走、每天保什么、晚点砍什么、钱大概落不落在自己设的区间里。做成的标志是三件事同时成立：

1. 封面用四句话读完这趟：去哪、最长一天、人均是否在档、一条必知。
2. 每一天标题下有一句取舍：出发时间窗、今天要保住的锚点、晚点先砍的可选站。
3. 发给同伴时，链接指向真实的只读分享页。链接没写成，海报不画二维码。

高铁卡只展示参考班次并跳到 12306。页面不订票、不订房，也不做攻略广场。一次只维护当前这一版。

## 二、主路径用规则拼路书

封面第三句和改路后的后果句，用户会拿去核对「人均还在不在档」「改完多开了多少公里」。这些数字要能回到同一套公式和路线数据。

因此默认不让大模型重写全文。日程、途经、预算、避坑、行前清单都由规则和工具结果拼出来。环境变量 `ROADBOOK_LLM_REFINE=1` 时，才会在约 7 秒内尝试用通义替换部分文案；超时就继续用已经算好的路书。界面上没有单独的精修开关。

对话改路也先识别意图：天数、途经、节奏、主题、预算、某一天换成某个景点。改起终点或途经城时，会再向高德要一次路线。回复末尾写里程增减，以及人均仍在、低于或超出原来的区间。

## 三、MCP 只提供事实

高德的路线、天气、POI，Tavily 的配图，12306 的班次参考，都经 MCP 子进程调用。规划器看到的是「工具名 + 参数 → 结果」，不把各家 SDK 写进日程函数里。

缺 Key 时，对应服务不注册，进程照常启动。MCP 交出来的是折线、天气、站点和班次；封面四句和每天保什么、砍什么，仍由规划与页面决定。

## 四、边算边画

一次规划要落坐标、画路线、查天气、排日程。`POST /api/plan` 用 SSE 分段推送：先出标题和骨架，里程先写「计算中」，再补路线、天气和逐日内容。页面状态依次是：理解需求、落坐标、画出路线、查天气、整理行程。

改路不走这条流。对话微调和途经重排都在新路书上整本重算，不另开一套方案列表。

## 五、分享是一份只读快照

「发出这一版」把当前路书写成一份公开快照。同伴打开分享页可以看行程、预算和准备，也可以导航，不能改原件。收藏和「据此修改」写到本机。

海报在链接写成之后才画二维码。失败时复制按钮停在「链接未就绪」，画布写明这一版链接暂未写成。PNG 仍可下载。

结构可以看成：

```text
浏览器
  → travel_app.py        HTTP / SSE
  → trip_planner.py      规则规划，可选文案精修
  → mcp_client.py
       ├─ 高德 MCP        路线、天气、POI
       ├─ Tavily MCP      配图
       └─ 12306 MCP       班次参考
```

## 六、一次生成怎么走完

`travel_app.py` 的 `POST /api/plan` 调用 `trip_planner.plan_trip_async`，把阶段回调写成 SSE。前端 `static/js/roadbook-ui.js` 的 `startPlan` 读这些事件，交给 `handleStage`。

`trip_planner.py` 里的顺序是：

1. `parse_trip_request` 从表单和口语里抽出出发地、目的地、天数和偏好。句子说不清时，`static/js/brief-chat.js` 先打开「说清需求」，写回后再生成。
2. `plan_trip_async` 编排整次规划，并用 `stage` 推送骨架。
3. `_gather_amap_staged` 经 MCP 向高德取路线和天气。
4. `_build_fast_itinerary` 用规则交出逐日路书。
5. 出行方式是高铁加租车时，`_maybe_attach_hsr` 和 `rail_hsr.py` 附上班次参考、到站租车天数，并外链购票。

预算、清单、适合谁和慎选分别来自 `_build_budget`、`_build_checklist`、`_build_fit_verdict`。

## 七、三句文案分别写在哪

- 封面四句：`roadbook-ui.js` 的 `renderFirstGlance`。
- 每天一句取舍：同文件的 `dayPlayLine`。
- 改路后的里程差和人均是否在区间：`trip_planner.py` 的 `_edit_consequence_line`。对话入口是 `apply_chat_edit_async`，拖动途经顺序是 `apply_via_reorder_async`。

两次改路都在新的 trip 上重算。前端用 `mutationEpoch` 丢掉过期的 SSE 和改路响应，避免连点时旧结果盖住新结果。

## 八、页面怎么拆

- `static/js/roadbook-ui.js`：DOM、事件、SSE、地图、海报、本机草稿和历史。
- `static/js/roadbook-core.js`：预算重算、换一换，不碰 DOM。
- `static/js/platform-bridge.js`：导航、剪贴板、存储、密度。
- `static/js/brief-chat.js`：需求不完整时的追问和写回。
- `static/js/weather-fx.js`：天气粒子。
- `static/css/roadbook.css`：版式和深浅色。

本机状态键是 `roadbook_v1_history` 和 `roadbook_v1_edits`。刷新后可以回到上次草稿。有路书之后，底部胶囊才是改路入口：左侧展开对话，右侧是收藏和海报。

## 九、MCP 与写请求

`mcp_client.py` 的 `_build_servers()` 按环境变量注册服务：

- `AMAP_MAPS_API_KEY`：高德 `@amap/amap-maps-mcp-server`
- `TAVILY_API_KEY`：`tavily-mcp`
- `12306-mcp`：不需要 Key
- `DASHSCOPE_API_KEY`：通义，给可选精修和桌面助手用

`travel_app.py` 启动时调用 `warmup_servers`。规划阶段复用已拉起的 MCP 会话，避免每次请求都冷启动一个子进程。

写请求经过 `SecurityMiddleware`：校验 CSRF，并按 IP 限流。规划与改路另有内存里的每日次数，默认每天 40 次规划和 80 次改路，可用 `ROADBOOK_PLAN_DAILY`、`ROADBOOK_CHAT_DAILY` 调整。前端 `static/js/csrf.js` 给非 GET 的 `fetch` 带上令牌。

本地运行：

```bash
git clone https://github.com/devgxy/roadbook.git
cd roadbook
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python travel_app.py
```

浏览器打开 `http://127.0.0.1:7861`。算路需要 `AMAP_MAPS_API_KEY`。配图需要 `TAVILY_API_KEY`。通义需要 `DASHSCOPE_API_KEY`。

产品主路径、接口和界面说明在仓库的 `docs/product-design.md`、`docs/roadbook-spec.md`、`docs/interaction-ui.md`。

代码：[https://github.com/devgxy/roadbook](https://github.com/devgxy/roadbook)
