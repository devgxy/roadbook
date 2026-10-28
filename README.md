# Roadbook · 自驾路书

把一句口语收成几天自驾，或高铁到站再租车的路书。生成后先看封面四句，再按天看取舍；改完能把这一版用真链接发给同伴。

> 周末出发，把路写清楚。

打开首页即可生成。规划和高铁班次走本机进程，地图与配图通过 MCP 调用你自己的 Key。

## 能做什么

- **一句口语生成**：出发地、目的地、天数、节奏与主题，收成一版可看的路书
- **封面四句**：去哪、最长一天、人均是否在自己设的区间、一条必知
- **每天一句取舍**：出发时间窗、今天要保住的锚点、晚点先砍的可选站
- **副驾驶改路**：对话改天数 / 途经 / 节奏，或拖动途经顺序；回复末尾写里程差和人均是否还在区间
- **两种走法**：全程自驾，或高铁 + 到站租车（班次参考并外链 12306）
- **发出这一版**：海报带真分享链接；同伴打开只读副本（收藏 / 据此修改写到本机）

## 明确不做

- 不在本产品里订票、订房、查余票、支付
- 不做攻略广场，也不做多套方案并排对比
- 不做多人同时改同一份路书（分享出去的是发出那一刻的只读快照）

## 架构一览

浏览器打开 Starlette 服务；规划主路径走规则引擎（日程、预算、避坑可解释、可重算）。高德、Tavily、12306 只通过 MCP 提供路线、天气、配图和班次参考；缺 Key 时跳过对应服务，进程仍能启动。

```text
Browser  →  travel_app.py (Starlette / SSE)
                ↓
          trip_planner.py  （规则规划 + 可选文案精修）
                ↓
          mcp_client.py
           ├─ 高德地图 MCP   路线 / 天气 / POI
           ├─ Tavily MCP     配图检索
           └─ 12306 MCP      班次参考
```

更完整的设计取舍与实现对照，见 [docs/tech-article.md](docs/tech-article.md)。

## 本地运行

需要 **Python 3.11+**，以及本机可执行的 `npx`（用于拉起 MCP 子进程）。

```bash
git clone https://github.com/devgxy/roadbook.git
cd roadbook
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# 至少填入 AMAP_MAPS_API_KEY，否则无法算路

python travel_app.py
# 浏览器打开 http://127.0.0.1:7861
```

macOS 也可双击 [启动多MCP助手.command](启动多MCP助手.command)：会同时拉起桌面 MCP 助手（7860）与路书页（7861）。

## 需要配置什么

复制 `.env.example` 为 `.env`。

| 变量 | 是否必需 | 用途 |
|------|----------|------|
| `AMAP_MAPS_API_KEY` | **建议必填** | 高德 MCP：路线、天气、POI。不填则规划几乎不可用 |
| `TAVILY_API_KEY` | 可选 | 配图检索；不填则跳过配图 |
| `DASHSCOPE_API_KEY` | 可选 | 通义 / 桌面助手、可选文案精修 |
| `ROADBOOK_PLAN_DAILY` | 可选 | 单 IP 每日规划次数上限，默认 `40` |
| `ROADBOOK_CHAT_DAILY` | 可选 | 单 IP 每日改路次数上限，默认 `80` |
| `ROADBOOK_ADMIN_PASSWORD` | 可选 | 打开 `/admin` 看反馈统计；不配则后台不可用 |

申请 Key 的大致入口：

- 高德开放平台 → 创建应用 → Web 服务 Key（供 `@amap/amap-maps-mcp-server` 使用）
- [Tavily](https://tavily.com/) → API Key
- 阿里云百炼 / DashScope → API Key（要用通义或桌面助手时）

写操作有 CSRF 校验（前端 `csrf.js` 自动带上头）。规划 / 改路按客户端 IP 限制并发和每日次数，默认每天 40 次规划、80 次改路。

## 目录与入口

| 路径 | 说明 |
|------|------|
| `travel_app.py` | HTTP 服务、SSE 规划、CSRF / IP 限流、分享与反馈 |
| `trip_planner.py` | 需求解析、路线采集、日程 / 预算 / 避坑、对话改路 |
| `mcp_client.py` | 多 MCP 统一配置与按服务调用 |
| `rail_hsr.py` | 高铁班次与到站租车重组 |
| `templates/` | 规划页、后台（无登录页） |
| `static/js/roadbook-ui.js` | DOM、SSE、海报、对话微调 |
| `static/js/roadbook-core.js` | 预算 / 换站等无 DOM 逻辑 |
| `static/js/brief-chat.js` | 「说清需求」半屏对话 |
| `docs/product-design.md` | 产品主路径与能力边界 |
| `docs/roadbook-spec.md` | 产品 / 交互 / API 真值表 |
| `docs/interaction-ui.md` | 信息架构与视觉语言 |
| `docs/tech-article.md` | 技术文章（可转载到 CSDN / 公众号） |

## 第三方

- 地图可视化：[Apache ECharts](https://echarts.apache.org/)（`static/echarts.min.js`）
- UI 字体：[Outfit](https://fonts.google.com/specimen/Outfit)（本地 `static/fonts/*.woff2`），中文回落到系统黑体

## 许可证

[MIT](LICENSE)
