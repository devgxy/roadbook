"""出行行程编排：高德路线事实 + Tavily 攻略 → 分阶段结构化行程。"""

from __future__ import annotations

import asyncio
import base64
import colorsys
from io import BytesIO
import json
import math
import os
import re
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import dashscope
import httpx
from dashscope import Generation
from datetime import date, timedelta
from dotenv import load_dotenv
from PIL import Image

from holidays_cn import holiday_note, weekday_cn
from query_guard import PROVINCE_CITIES

from mcp_client import ROOT, has_server, open_server_session

load_dotenv(ROOT / ".env", override=True)
dashscope.api_key = os.getenv("DASHSCOPE_API_KEY", "")

ProgressCb = Callable[[str], None]
StageCb = Callable[[str, dict[str, Any]], Awaitable[None] | None]


def _noop_progress(_: str) -> None:
    pass


async def _emit(stage: StageCb | None, name: str, payload: dict[str, Any]) -> None:
    if not stage:
        return
    result = stage(name, payload)
    if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
        await result


def _chat(
    system: str,
    user: str,
    temperature: float = 0.2,
    model: str | None = None,
) -> str:
    """使用 httpx 直连百炼 OpenAI 兼容接口（带明确超时，避免 SDK 死等）。"""
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    primary = model or os.getenv("TRIP_PLANNER_MODEL", "qwen-plus-latest")
    chain = [primary] + [
        m for m in ("qwen-plus-latest", "qwen-plus", "qwen-max") if m != primary
    ]
    last_err: Exception | None = None
    with httpx.Client(timeout=8.5) as client:
        for chosen in chain:
            try:
                resp = client.post(
                    url,
                    headers={"Authorization": f"Bearer {key}"},
                    json={
                        "model": chosen,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                        "temperature": temperature,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"].strip()
                last_err = RuntimeError(f"HTTP {resp.status_code}")
            except Exception as e:
                last_err = e
    raise RuntimeError(str(last_err or "模型调用失败"))


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise
        return json.loads(match.group(0))


def _normalize_pref(value: str, allowed: set[str], default: str) -> str:
    v = (value or "").strip().lower()
    return v if v in allowed else default


def parse_trip_request(
    query: str = "",
    origin: str = "",
    destination: str = "",
    days: int | None = None,
    pace: str = "balanced",
    theme: str = "landmark",
    budget_level: str = "comfort",
    highway: str = "express",
    budget_min: int | None = None,
    budget_max: int | None = None,
    pax: int = 2,
    energy_type: str = "oil",
    travel_mode: str = "drive",
) -> dict[str, Any]:
    """从自然语言或表单字段抽取出发地、目的地、天数与偏好（含预算区间）。"""
    mode = str(travel_mode or "drive").lower()
    if mode not in ("drive", "hsr_rental"):
        mode = "drive"
    prefs = {
        "pace": _normalize_pref(pace, set(PACE_DAILY_KM), "balanced"),
        "theme": _normalize_pref(theme, set(THEME_LABELS), "landmark"),
        "budget_level": _normalize_pref(budget_level, set(BUDGET_DAILY), "comfort"),
        "highway": _normalize_pref(highway, {"express", "scenic"}, "express"),
        "budget_min": int(budget_min) if budget_min not in (None, "", 0) else None,
        "budget_max": int(budget_max) if budget_max not in (None, "", 0) else None,
        "pax": max(1, min(5, int(pax or 2))),
        "energy_type": "ev" if str(energy_type or "").lower() == "ev" else "oil",
        "travel_mode": mode,
    }
    def _clamp_days(raw: Any) -> int:
        try:
            return max(1, min(int(raw), 14))
        except (TypeError, ValueError):
            return 7

    if origin.strip() and destination.strip():
        return {
            "origin": origin.strip(),
            "destination": destination.strip(),
            "days": _clamp_days(days if days not in (None, "") else 7),
            **prefs,
        }

    blob = query.strip()
    if not blob:
        return {
            "origin": origin.strip(),
            "destination": destination.strip(),
            "days": _clamp_days(days if days not in (None, "") else 7),
            **prefs,
        }
    system = (
        "你是出行参数抽取器。只输出 JSON，不要解释。"
        '格式: {"origin":"出发地","destination":"目的地","days":天数整数}'
        "若未给出天数，默认 7；若信息不足，缺失字段用空字符串或 7。"
    )
    data = _extract_json(_chat(system, blob))
    parsed_days = _clamp_days(data.get("days") or days or 7)
    return {
        "origin": (data.get("origin") or origin or "").strip(),
        "destination": (data.get("destination") or destination or "").strip(),
        "days": parsed_days,
        **prefs,
    }


CITY_COORDS: dict[str, str] = {
    "北京": "116.407387,39.904179",
    "上海": "121.473701,31.230416",
    "广州": "113.264385,23.129112",
    "深圳": "114.057868,22.543099",
    "成都": "104.066301,30.572961",
    "杭州": "120.155070,30.274084",
    "西安": "108.939770,34.341568",
    "重庆": "106.551556,29.563009",
    "武汉": "114.305393,30.593099",
    "南京": "118.796877,32.060255",
    "苏州": "120.585315,31.298886",
    "天津": "117.200983,39.084158",
    "长沙": "112.938814,28.228209",
    "郑州": "113.625368,34.746600",
    "青岛": "120.382640,36.067082",
    "厦门": "118.089425,24.479834",
    "昆明": "102.832891,24.880095",
    "大理": "100.225668,25.589449",
    "丽江": "100.227750,26.855047",
    "拉萨": "91.140856,29.645554",
    "兰州": "103.834303,36.061089",
    "西宁": "101.778228,36.617144",
    "敦煌": "94.661590,40.142128",
    "乌鲁木齐": "87.616848,43.825592",
    "三亚": "109.511909,18.252847",
    "海口": "110.198293,20.044002",
    "桂林": "110.290195,25.273566",
    "贵阳": "106.630153,26.647661",
    "沈阳": "123.431474,41.805698",
    "大连": "121.614682,38.914003",
    "哈尔滨": "126.534967,45.803775",
    "石家庄": "114.514860,38.042307",
    "太原": "112.548879,37.870590",
    "洛阳": "112.454040,34.619682",
    "汉中": "107.023323,33.067480",
    "保定": "115.464806,38.873891",
    "德州": "116.359381,37.434092",
    "济南": "117.120098,36.651216",
    "泰安": "117.088420,36.200252",
    "徐州": "117.283752,34.204402",
    "开封": "114.314278,34.798083",
    "许昌": "113.852640,34.037032",
    "南阳": "112.528322,32.990833",
    "襄阳": "112.144146,32.042426",
    "十堰": "110.787916,32.646907",
    "安康": "109.029022,32.690300",
    "绵阳": "104.679114,31.467450",
    "德阳": "104.398651,31.127991",
    "广元": "105.843357,32.435435",
    "宝鸡": "107.237682,34.362894",
    "咸阳": "108.708991,34.329605",
    "渭南": "109.509786,34.499996",
    "运城": "111.007529,35.026412",
    "临汾": "111.518976,36.088005",
    "大同": "113.300129,40.076763",
    "张家口": "114.885895,40.768931",
    "承德": "117.962410,40.954250",
    "秦皇岛": "119.600467,39.935385",
    "唐山": "118.180194,39.630867",
    "沧州": "116.838715,38.304477",
    "衡水": "115.670238,37.738920",
    "邯郸": "114.539150,36.625656",
    "安阳": "114.392392,36.097577",
    "新乡": "113.883991,35.302616",
    "焦作": "113.241823,35.215893",
    "商丘": "115.656358,34.414162",
    "周口": "114.701222,33.634652",
    "信阳": "114.091094,32.146984",
    "驻马店": "114.022298,33.012952",
    "合肥": "117.227267,31.820586",
    "芜湖": "118.376451,31.326319",
    "黄山": "118.337482,29.714657",
    "南昌": "115.858198,28.682892",
    "九江": "115.992811,29.712034",
    "景德镇": "117.178222,29.268835",
    "福州": "119.296494,26.074507",
    "泉州": "118.675676,24.874452",
    "温州": "120.699367,27.993849",
    "宁波": "121.550357,29.874557",
    "嘉兴": "120.755486,30.746186",
    "湖州": "120.086823,30.894348",
    "绍兴": "120.582112,29.997117",
    "金华": "119.647445,29.079059",
    "无锡": "120.311910,31.491169",
    "常州": "119.973987,31.810689",
    "扬州": "119.412966,32.394210",
    "镇江": "119.425836,32.187949",
    "南通": "120.894291,31.980171",
    "盐城": "120.139998,33.377631",
    "淮安": "119.015288,33.610364",
    "连云港": "119.221611,34.596653",
    "珠海": "113.576726,22.270715",
    "佛山": "113.121586,23.021478",
    "东莞": "113.751799,23.020536",
    "惠州": "114.415585,23.112381",
    "中山": "113.392585,22.517000",
    "汕头": "116.681972,23.354091",
    "湛江": "110.357538,21.270108",
    "南宁": "108.366543,22.817002",
    "柳州": "109.428123,24.326442",
    "北海": "109.119254,21.473343",
    "宜昌": "111.286471,30.691967",
    "荆州": "112.241866,30.332591",
    "岳阳": "113.128958,29.357104",
    "常德": "111.691347,29.040225",
    "张家界": "110.479921,29.127401",
    "遵义": "106.937265,27.706626",
    "都匀": "107.518737,26.259427",
    "安顺": "105.946198,26.253103",
    "曲靖": "103.796167,25.490021",
    "玉溪": "102.543907,24.350461",
    "西双版纳": "100.797777,22.007351",
    "香格里拉": "99.706463,27.829740",
    "雅安": "103.013261,29.980171",
    "乐山": "103.765678,29.552106",
    "宜宾": "104.630825,28.760189",
    "泸州": "105.443348,28.871811",
    "南充": "106.110698,30.837793",
    "达州": "107.467911,31.209484",
    "眉山": "103.848403,30.075429",
    "银川": "106.230909,38.487194",
    "包头": "109.840347,40.657449",
    "呼和浩特": "111.749181,40.842585",
    "鄂尔多斯": "109.781327,39.608266",
    "嘉峪关": "98.281635,39.875423",
    "张掖": "100.449858,38.932325",
    "酒泉": "98.508414,39.732411",
    "格尔木": "94.903300,36.402380",
    "喀什": "75.989138,39.467664",
    "库尔勒": "86.145298,41.763122",
    "吐鲁番": "89.266025,42.950743",
    "延边": "129.470022,42.904823",
    "长春": "125.323544,43.817072",
    "吉林": "126.549576,43.838136",
    "鞍山": "122.994329,41.108647",
    "锦州": "121.127003,41.095118",
    # 自驾宝藏县域 / 古城节点
    "都江堰": "103.619415,30.998250",
    "广汉": "104.282389,30.976865",
    "峨眉山": "103.484499,29.601251",
    "康定": "101.963815,30.050773",
    "稻城": "100.298431,29.037554",
    "平遥": "112.175526,37.189322",
    "五台": "113.591090,39.018935",
    "壶口": "110.471200,36.143300",
    "华阴": "110.092277,34.565352",
    "临潼": "109.214174,34.366651",
    "乾县": "108.242343,34.528098",
    "腾冲": "98.490980,25.020488",
    "建水": "102.826586,23.619773",
    "沙溪": "99.852000,26.319000",
    "阳朔": "110.496590,24.778440",
    "凤凰": "109.599220,27.948272",
    "婺源": "117.861732,29.248400",
    "宏村": "117.988500,30.001200",
    "莫干山": "119.860200,30.601500",
    "安吉": "119.680684,30.638025",
    "桐庐": "119.691358,29.793232",
    "敦煌莫高窟": "94.809100,40.041900",
}

# 热门目的地 → 顺路宝藏卫星县（各含 1 个代表锚点与美食，0 API 消耗）
SATELLITE_GEMS: dict[str, list[dict[str, str]]] = {
    "成都": [
        {
            "county": "都江堰市",
            "sight": "都江堰水利工程·南桥夜景",
            "place": "成都都江堰市公园路",
            "location": "103.619415,30.998250",
            "tag": "#世界遗产 #蓝眼泪夜景",
            "food": "都江堰钟鸭子·老号尤兔头",
            "food_place": "都江堰市幸福路",
        },
        {
            "county": "广汉市",
            "sight": "三星堆博物馆新馆",
            "place": "德阳广汉市西安路133号",
            "location": "104.216500,31.002100",
            "tag": "#古蜀神迹 #必提前预约",
            "food": "广汉名小食·金丝面",
            "food_place": "广汉市汉州大道",
        },
    ],
    "西安": [
        {
            "county": "临潼区",
            "sight": "秦始皇帝陵博物院(兵马俑)·丽山园",
            "place": "西安市临潼区秦陵北路",
            "location": "109.278500,34.384100",
            "tag": "#世界第八奇迹 #必请讲解",
            "food": "临潼石子馍·关中老碗面",
            "food_place": "临潼区华清路",
        },
        {
            "county": "华阴市",
            "sight": "西岳华山·西峰索道观景",
            "place": "渭南华阴市玉泉路南段",
            "location": "110.088600,34.489200",
            "tag": "#奇险天下第一山 #县域一日",
            "food": "华阴大刀面·麻食泡",
            "food_place": "华阴市太华南路",
        },
    ],
    "杭州": [
        {
            "county": "安吉县",
            "sight": "安吉大竹海·小杭坑露营线",
            "place": "湖州市安吉县天荒坪镇",
            "location": "119.680684,30.638025",
            "tag": "#竹海盘山道 #自驾神线",
            "food": "安吉老李家竹林鸡煲",
            "food_place": "安吉县递铺街道",
        },
        {
            "county": "桐庐县",
            "sight": "富春江小三峡·严子陵钓台",
            "place": "杭州市桐庐县富春江镇",
            "location": "119.691358,29.793232",
            "tag": "#富春山居图实景 #县城慢游",
            "food": "桐庐江鲜馆·清蒸白水鱼",
            "food_place": "桐庐县迎春南路",
        },
    ],
    "兰州": [
        {
            "county": "永靖县",
            "sight": "炳灵寺石窟·刘家峡水库黄洮交汇",
            "place": "临夏州永靖县刘家峡镇",
            "location": "103.178200,35.809100",
            "tag": "#黄河峡谷 #小众石窟",
            "food": "刘家峡黄河大鲤鱼",
            "food_place": "永靖县太极镇",
        }
    ],
    "大理": [
        {
            "county": "剑川县·沙溪",
            "sight": "沙溪古镇·玉津桥与先锋书局",
            "place": "大理州剑川县寺登街",
            "location": "99.852000,26.319000",
            "tag": "#茶马古道唯一幸存集市 #有风的地方",
            "food": "沙溪古镇火塘牛肉火锅",
            "food_place": "剑川县沙溪镇古戏台旁",
        }
    ],
    "桂林": [
        {
            "county": "阳朔县",
            "sight": "遇龙河十里画廊·工农桥日落",
            "place": "桂林市阳朔县遇龙河景区",
            "location": "110.496590,24.778440",
            "tag": "#喀斯特田园 #电瓶车慢游",
            "food": "阳朔大师傅啤酒鱼",
            "food_place": "阳朔西街口",
        }
    ],
    "太原": [
        {
            "county": "平遥县",
            "sight": "平遥古城墙·日升昌票号",
            "place": "晋中市平遥县照壁南街",
            "location": "112.175526,37.189322",
            "tag": "#晋商票号 #明清县城活化石",
            "food": "平遥牛肉·洪武记碗托",
            "food_place": "平遥古城南大街",
        }
    ],
}

CITY_VIBES: dict[str, dict[str, Any]] = {
    "北京": {"tags": ["皇城根", "胡同秋色", "北国起点"], "bite": "铜锅涮肉 / 卤煮火烧"},
    "太原": {"tags": ["晋商故里", "古建博物馆", "碳水天堂"], "bite": "头脑 / 刀削面 / 过油肉"},
    "平遥": {"tags": ["明清县城", "晋商票号", "青砖灯影"], "bite": "平遥牛肉 / 莜面栲栳栳"},
    "石家庄": {"tags": ["太行东麓", "正定古刹", "冀中枢纽"], "bite": "正定八大碗 / 安徽板面"},
    "运城": {"tags": ["河东盐池", "全国古建第一大市", "关公故里"], "bite": "运城大盘鸡 / 绛州火锅"},
    "临汾": {"tags": ["壶口黄河", "大槐树寻根", "晋南粮仓"], "bite": "牛肉丸子面"},
    "西安": {"tags": ["十三朝古都", "城墙日落", "碳水之都"], "bite": "肉夹馍 / 葫芦鸡 / 油泼面"},
    "汉中": {"tags": ["秦岭南麓", "两汉三国", "朱鹮之乡"], "bite": "汉中热米皮 / 菜豆腐"},
    "广元": {"tags": ["剑门蜀道", "女皇故里", "川北门户"], "bite": "广元蒸凉面 / 剑门豆腐宴"},
    "绵阳": {"tags": ["越王楼夜景", "川西北重镇", "米粉之城"], "bite": "绵阳米粉 / 江油肥肠"},
    "成都": {"tags": ["安逸茶馆", "街头烟火", "蜀道终点"], "bite": "社区老火锅 / 冒烤鸭 / 盖碗茶"},
    "上海": {"tags": ["梧桐街区", "外滩江风", "海派摩登"], "bite": "本帮红烧肉 / 生煎"},
    "杭州": {"tags": ["西湖烟雨", "龙井茶山", "江南慢调"], "bite": "片儿川 / 葱包桧 / 龙井虾仁"},
    "苏州": {"tags": ["园林水巷", "评弹茶肆", "苏式慢生活"], "bite": "三虾面 / 哑巴生煎"},
    "南京": {"tags": ["六朝烟水", "梧桐大道", "鸭都风味"], "bite": "盐水鸭 / 鸭血粉丝汤"},
    "兰州": {"tags": ["黄河穿城", "铁桥日落", "西北门户"], "bite": "头汤牛肉面 / 手抓羊肉"},
    "西宁": {"tags": ["青藏咽喉", "塔尔寺金顶", "清凉夏都"], "bite": "炕锅羊肉 / 牦牛酸奶"},
    "敦煌": {"tags": ["大漠孤烟", "飞天壁画", "河西走廊尽头"], "bite": "驴肉黄面 / 杏皮水"},
    "重庆": {"tags": ["8D山城", "两江夜渡", "江湖码头"], "bite": "九宫格老火锅 / 重庆小面"},
    "武汉": {"tags": ["大江大湖", "轮渡日落", "过早江湖"], "bite": "热干面 / 三鲜豆皮 / 藕汤"},
    "长沙": {"tags": ["湘江橘洲", "不夜烟火", "岳麓书香"], "bite": "小龙虾 / 臭豆腐 / 茶颜"},
    "昆明": {"tags": ["春城花市", "滇池海鸥", "野生菌王国"], "bite": "小锅米线 / 汽锅鸡"},
    "大理": {"tags": ["苍山洱海", "白族院落", "风花雪月"], "bite": "喜洲破酥粑粑 / 酸辣鱼"},
    "丽江": {"tags": ["玉龙雪山", "茶马古镇", "纳西火塘"], "bite": "腊排骨火锅 / 鸡豆凉粉"},
    "桂林": {"tags": ["漓江烟雨", "喀斯特峰林", "山水画卷"], "bite": "桂林米粉 / 阳朔啤酒鱼"},
    "贵阳": {"tags": ["喀斯特山林", "折耳根宇宙", "避暑酸汤"], "bite": "凯里酸汤鱼 / 丝娃娃"},
    "三亚": {"tags": ["椰风海韵", "环岛公路", "热带落日"], "bite": "糟粕醋火锅 / 清补凉"},
}


def _city_vibe(city: str) -> dict[str, Any]:
    clean = re.sub(r"[市省区县州]$", "", (city or "").strip())
    v = CITY_VIBES.get(clean) or CITY_VIBES.get(city)
    if v:
        return {"city": clean, "tags": v["tags"], "bite": v["bite"]}
    return {"city": clean or city, "tags": ["沿途节点", "休整补给", "地道风味"], "bite": f"{clean or city}家常风味"}


def _build_city_candidate_pool(city: str) -> dict[str, list[dict[str, Any]]]:
    """为任意途经城构建专属候选池（4~5个景点 + 3~4个地道美食），保证换一换绝不跨城串味。"""
    clean = re.sub(r"[市省区县州]$", "", (city or "").strip()) or city
    vibe = _city_vibe(clean)
    loc = _cached_coord(clean) or ""
    sights: list[dict[str, Any]] = []
    foods: list[dict[str, Any]] = []
    for g in SATELLITE_GEMS.get(clean) or []:
        sights.append(
            {
                "name": g["sight"],
                "address": g["place"],
                "image": "",
                "location": g["location"],
                "rating": "4.8",
                "cost": "",
                "tag": "顺路名胜",
                "city": clean,
                "district": g["county"],
                "is_county": True,
                "human_tags": [f"#顺路县域·{g['county']}"] + g["tag"].split()[:2],
                "stay_hours": 2.0,
            }
        )
        if g.get("food"):
            foods.append(
                {
                    "name": g["food"],
                    "address": g.get("food_place") or g["county"],
                    "image": "",
                    "location": g["location"],
                    "rating": "4.8",
                    "cost": "48",
                    "tag": "地道风味",
                    "city": clean,
                    "district": g["county"],
                    "is_county": True,
                    "human_tags": [f"#{g['county']}老店", "#顺路必吃"],
                    "stay_hours": 1.5,
                }
            )
    preset_spots = [
        (f"{clean}·{vibe['tags'][0]}历史街区", f"{clean}老城核心历史文化街区", [f"#{vibe['tags'][0]}", "#免门票"]),
        (f"{clean}博物馆·城市记忆馆", f"{clean}市中心文博广场", ["#城市名片", "#室内好逛"]),
        (f"{clean}古城墙/江滨日落观景台", f"{clean}老城观景步道", [f"#{vibe['tags'][1]}", "#傍晚机位"]),
        (f"{clean}人民公园·老茶馆体验", f"{clean}老城区市民公园", ["#当地慢生活", "#歇脚放松"]),
    ]
    for title, addr, htags in preset_spots:
        sights.append(
            {
                "name": title,
                "address": addr,
                "image": "",
                "location": loc,
                "rating": "4.7",
                "cost": "",
                "tag": "城市人文",
                "city": clean,
                "district": clean,
                "is_county": False,
                "human_tags": htags,
                "stay_hours": 1.5,
            }
        )
    bites = [b.strip() for b in vibe["bite"].split("/") if b.strip()] or [f"{clean}招牌菜"]
    for idx, b in enumerate(bites):
        foods.append(
            {
                "name": f"{clean}老字号·{b}",
                "address": f"{clean}老城烟火美食街 {idx + 1} 号",
                "image": "",
                "location": loc,
                "rating": "4.8",
                "cost": str(35 + idx * 15),
                "tag": "地道老店",
                "city": clean,
                "district": clean,
                "is_county": False,
                "human_tags": ["#本地人扎堆", f"#{b}"],
                "stay_hours": 1.5,
            }
        )
    foods.append(
        {
            "name": f"{clean}夜市排档·炭火烧烤",
            "address": f"{clean}老街夜市集",
            "image": "",
            "location": loc,
            "rating": "4.7",
            "cost": "55",
            "tag": "夜市风味",
            "city": clean,
            "district": clean,
            "is_county": False,
            "human_tags": ["#晚间烟火", "#自驾解乏"],
            "stay_hours": 1.5,
        }
    )
    return {"sights": sights, "foods": foods}


def _human_tags_for_poi(
    name: str,
    raw_tag: str,
    rating: str,
    cost: str,
    district: str,
    is_county: bool,
    stop_type: str,
) -> list[str]:
    tags: list[str] = []
    if is_county and district:
        tags.append(f"#宝藏县域·{district}")
    if stop_type == "food":
        tags.append("#本地人扎堆")
        if re.search(r"老|记|传统|总店|非遗", name):
            tags.append("#老字号")
    else:
        if re.search(r"博物|遗址|故居|古镇|古建|寺|祠|陵|石窟|城墙", name + raw_tag):
            tags.append("#人文必看")
            tags.append("#建议提前预约")
        elif re.search(r"塔|夜景|江|桥|湖|山|台|湾|海", name + raw_tag):
            tags.append("#日落/夜景机位")
        elif re.search(r"公园|植物|动物|乐园|熊猫", name + raw_tag):
            tags.append("#轻松好逛")
        else:
            tags.append("#出片打卡")
    try:
        if cost and float(cost) == 0:
            tags.append("#免门票")
    except ValueError:
        pass
    try:
        if rating and float(rating) >= 4.7 and len(tags) < 3:
            tags.append("#高分口碑")
    except ValueError:
        pass
    return tags[:3]

PACE_DAILY_KM = {"relaxed": 450.0, "balanced": 600.0, "hardcore": 750.0}
PACE_STOPS = {"relaxed": 2, "balanced": 3, "hardcore": 4}
# 以「单人日均吃住玩花费（不含过路费/油费）」为基准，符合真实出行常识，不产生高价惊吓
BUDGET_DAILY = {
    "economy": {
        "hotel_room": 160.0,   # 快捷/青旅标准间 ¥160/晚（2人分摊仅 ¥80/人）
        "food_pp": 65.0,       # 粉面小吃+简餐 ¥65/人·天
        "ticket_pp": 25.0,     # 免票公园为主 ¥25/人·天
        "daily_range": (150, 260),
        "label": "经济省钱",
        "desc": "快捷连锁 · 地道面馆小吃 · 优选免票景点",
    },
    "comfort": {
        "hotel_room": 300.0,   # 舒适全季/亚朵级 ¥300/晚（2人分摊 ¥150/人）
        "food_pp": 110.0,      # 必吃榜老字号 ¥110/人·天
        "ticket_pp": 45.0,     # 核心必去景区 ¥45/人·天
        "daily_range": (260, 420),
        "label": "舒适口碑",
        "desc": "舒适品牌酒店 · 必吃老字号 · 核心景区含票",
    },
    "premium": {
        "hotel_room": 620.0,   # 精品景观/高星酒店 ¥620/晚（2人分摊 ¥310/人）
        "food_pp": 180.0,      # 特色私房/景观餐厅 ¥180/人·天
        "ticket_pp": 80.0,     # 含索道/演艺/深度体验 ¥80/人·天
        "daily_range": (450, 780),
        "label": "品质度假",
        "desc": "高星景观美宿 · 特色风味大餐 · 含索道深度体验",
    },
}
THEME_LABELS = {
    "landmark": "经典地标",
    "family": "亲子友好",
    "photo": "人文摄影",
    "food": "烟火美食",
}


def _cached_coord(name: str) -> str | None:
    clean = re.sub(r"[市省区县]$", "", (name or "").strip())
    return CITY_COORDS.get(clean) or CITY_COORDS.get((name or "").strip())


def _parse_loc(loc: str) -> tuple[float, float] | None:
    try:
        lng_s, lat_s = str(loc).split(",")
        return float(lng_s), float(lat_s)
    except Exception:
        return None


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lng1, lat1 = map(math.radians, a)
    lng2, lat2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def _city_points() -> list[tuple[str, float, float]]:
    out: list[tuple[str, float, float]] = []
    for name, loc in CITY_COORDS.items():
        parsed = _parse_loc(loc)
        if parsed:
            out.append((name, parsed[0], parsed[1]))
    return out


def _nearest_city(
    lng: float,
    lat: float,
    exclude: set[str] | None = None,
    max_km: float = 120.0,
) -> str | None:
    exclude = exclude or set()
    best_name: str | None = None
    best_d = max_km
    for name, clng, clat in _city_points():
        if name in exclude:
            continue
        d = _haversine_km((lng, lat), (clng, clat))
        if d < best_d:
            best_d = d
            best_name = name
    return best_name


def _polyline_cum_km(points: list[str]) -> list[tuple[str, float]]:
    """返回 [(loc, 累计公里)]。"""
    out: list[tuple[str, float]] = []
    total = 0.0
    prev: tuple[float, float] | None = None
    for loc in points:
        cur = _parse_loc(loc)
        if not cur:
            continue
        if prev:
            total += _haversine_km(prev, cur)
        out.append((loc, total))
        prev = cur
    return out


def _distance_km_from_text(distance: str | None) -> float:
    if not distance:
        return 0.0
    m = re.search(r"([\d.]+)", str(distance))
    return float(m.group(1)) if m else 0.0


def _trip_distance_km(trip: dict[str, Any] | None) -> float:
    if not isinstance(trip, dict):
        return 0.0
    raw = trip.get("distance_km")
    try:
        if raw is not None and float(raw) > 0:
            return float(raw)
    except (TypeError, ValueError):
        pass
    return _distance_km_from_text(trip.get("distance"))


def _edit_consequence_line(old_trip: dict[str, Any], new_trip: dict[str, Any]) -> str:
    """改完一句后果：里程增减 + 人均是否仍在区间；超出时给一个回到区间的做法。"""
    old_km = _trip_distance_km(old_trip)
    new_km = _trip_distance_km(new_trip)
    delta = int(round(new_km - old_km))
    if abs(delta) < 5:
        mile = "全程里程几乎不变"
    elif delta < 0:
        mile = f"全程少开约 {abs(delta)} km"
    else:
        mile = f"全程多开约 {delta} km"

    budget = new_trip.get("budget") if isinstance(new_trip.get("budget"), dict) else {}
    status = str(budget.get("status") or "")
    pp = budget.get("per_person")
    try:
        pp_n = int(round(float(pp))) if pp is not None else None
    except (TypeError, ValueError):
        pp_n = None
    pp_bit = f"人均约 ¥{pp_n}" if pp_n is not None else "人均"

    if status == "over":
        tip = "可先砍一个顺路可选付费站"
        for day in new_trip.get("days_plan") or []:
            if not isinstance(day, dict):
                continue
            for it in day.get("items") or []:
                if not isinstance(it, dict):
                    continue
                if it.get("priority") == "optional" and it.get("title"):
                    name = re.sub(r"[（(].*$", "", str(it.get("title") or "")).strip()
                    if name:
                        tip = f"可先砍「{name}」这类可选站"
                        break
            else:
                continue
            break
        return f"{mile}；{pp_bit}，超出你设的区间，{tip}"
    if status == "under":
        return f"{mile}；{pp_bit}，仍低于你设的区间"
    if status == "fit" or pp_n is not None:
        return f"{mile}；{pp_bit}，仍在你设的区间"
    return mile


def _duration_hours_from_text(duration: str | None) -> float:
    if not duration:
        return 0.0
    m = re.search(r"([\d.]+)", str(duration))
    return float(m.group(1)) if m else 0.0


def _match_via_cities(
    polyline: list[str],
    origin: str,
    destination: str,
    transit_days: int,
    total_km: float,
    custom_via: list[str] | None = None,
    exclude_via: set[str] | None = None,
    fill_via: bool = True,
    leg_km: list[float] | None = None,
) -> list[dict[str, Any]]:
    """按折线分位点匹配真实途经城市，支持强制途经 custom_via 与排除 exclude_via。

    fill_via=False 时只使用 custom_via，不再按里程自动补中途城（用户删城 / 拖拽排序）。
    leg_km 为高德逐段实测里程（与最终节点相邻段一一对应时才采用，否则按球面距离估算）。
    """
    origin_clean = re.sub(r"[市省区县]$", "", origin.strip()) or origin.strip()
    dest_clean = re.sub(r"[市省区县]$", "", destination.strip()) or destination.strip()
    exclude = {re.sub(r"[市省区县]$", "", x.strip()) for x in (exclude_via or set()) if x}
    custom_list = [
        re.sub(r"[市省区县]$", "", c.strip())
        for c in (custom_via or [])
        if c and re.sub(r"[市省区县]$", "", c.strip()) not in {origin_clean, dest_clean} | exclude
    ]
    o_loc = _cached_coord(origin_clean) or (polyline[0] if polyline else "")
    d_loc = _cached_coord(dest_clean) or (polyline[-1] if polyline else "")
    o_pt = _parse_loc(o_loc)
    nodes: list[dict[str, Any]] = [
        {
            "name": origin_clean,
            "location": o_loc,
            "cum_km": 0.0,
            "role": "origin",
        }
    ]
    if (transit_days <= 0 or not fill_via) and not custom_list:
        nodes.append(
            {
                "name": dest_clean,
                "location": d_loc,
                "cum_km": total_km,
                "role": "destination",
            }
        )
        return nodes

    cum = _polyline_cum_km(polyline)
    route_total = (cum[-1][1] if cum else 0.0) or total_km or 1.0
    used = {origin_clean, dest_clean} | exclude

    # 1) 先把用户指定的 custom_via 放进去，按距起点的球面距离估算 cum_km
    for cname in custom_list:
        cloc = _cached_coord(cname)
        if not cloc:
            continue
        cpt = _parse_loc(cloc)
        est_km = _haversine_km(o_pt, cpt) * 1.28 if (o_pt and cpt) else route_total * 0.5
        used.add(cname)
        nodes.append(
            {
                "name": cname,
                "location": cloc,
                "cum_km": round(min(route_total * 0.94, max(40.0, est_km)), 1),
                "role": "via",
                "custom": True,
            }
        )

    # 2) 若还需要更多中间落脚城，再从 polyline 分位点补齐
    need_mids = max(0, transit_days - 1)
    if fill_via and cum and len(nodes) - 1 < need_mids:
        for i in range(1, max(transit_days, 1)):
            if len(nodes) - 1 >= need_mids:
                break
            target = route_total * (i / transit_days)
            best = min(cum, key=lambda x: abs(x[1] - target))
            parsed = _parse_loc(best[0])
            if not parsed:
                continue
            city = _nearest_city(parsed[0], parsed[1], exclude=used, max_km=160.0)
            if not city:
                continue
            used.add(city)
            nodes.append(
                {
                    "name": city,
                    "location": CITY_COORDS[city],
                    "cum_km": round(best[1], 1),
                    "role": "via",
                }
            )

    nodes.append(
        {
            "name": dest_clean,
            "location": d_loc or (cum[-1][0] if cum else ""),
            "cum_km": round(route_total if route_total else total_km, 1),
            "role": "destination",
        }
    )
    # 去重并按 cum_km 排序，重算真实相邻球面累加里程（保证绕道城市里程合理）
    dedup: list[dict[str, Any]] = []
    seen: set[str] = set()
    for n in sorted(nodes, key=lambda x: float(x.get("cum_km") or 0)):
        if n["name"] in seen:
            continue
        seen.add(n["name"])
        dedup.append(n)
    if custom_list and len(dedup) >= 2:
        origin_n, dest_n = dedup[0], dedup[-1]
        mid_by_name = {n["name"]: n for n in dedup[1:-1]}
        ordered_mids: list[dict[str, Any]] = []
        for c in custom_list:
            if c in mid_by_name:
                ordered_mids.append(mid_by_name.pop(c))
        ordered_mids.extend(mid_by_name.values())
        dedup = [origin_n, *ordered_mids, dest_n]
        acc = 0.0
        prev_pt = _parse_loc(dedup[0].get("location") or "")
        dedup[0]["cum_km"] = 0.0
        if leg_km and len(leg_km) == len(dedup) - 1:
            for item, seg in zip(dedup[1:], leg_km):
                acc += float(seg)
                item["cum_km"] = round(acc, 1)
            return dedup
        for item in dedup[1:]:
            cur_pt = _parse_loc(item.get("location") or "")
            if prev_pt and cur_pt:
                acc += _haversine_km(prev_pt, cur_pt) * 1.26
                item["cum_km"] = round(acc, 1)
            prev_pt = cur_pt or prev_pt
    return dedup


def _build_budget(
    distance_km: float,
    days: int,
    budget_level: str,
    highway: str,
    budget_min: int | None = None,
    budget_max: int | None = None,
    pax: int = 2,
    energy_type: str = "oil",
) -> dict[str, Any]:
    tier = BUDGET_DAILY.get(budget_level) or BUDGET_DAILY["comfort"]
    pax = max(1, min(5, int(pax or 2)))
    energy = "ev" if str(energy_type).lower() == "ev" else "oil"
    nights = max(days - 1, 1)
    rooms = max(1, math.ceil(pax / 2))

    # 1) 车费刚性成本（整车）
    km_rate = 0.18 if energy == "ev" else 0.58
    fuel = round(distance_km * km_rate)
    toll = round(distance_km * 0.42) if highway == "express" else 0
    rigid_total = fuel + toll
    rigid_pp = round(rigid_total / pax)

    # 2) 按「日均吃住玩标准 × 天数 + 车费分摊」推导合理默认区间，不再用写死的高价区间
    d_min, d_max = tier.get("daily_range", (260, 420))
    auto_min = round((d_min * days + rigid_pp * 0.85) / 50) * 50
    auto_max = round((d_max * days + rigid_pp * 1.15) / 50) * 50
    b_min = int(budget_min) if budget_min and int(budget_min) > 0 else auto_min
    b_max = int(budget_max) if budget_max and int(budget_max) > 0 else auto_max
    if b_max < b_min:
        b_min, b_max = b_max, b_min

    # 3) 食宿门票基准（按房间数与人数实算）
    base_hotel = tier["hotel_room"] * rooms * nights
    base_food = tier["food_pp"] * pax * days
    base_ticket = tier["ticket_pp"] * pax * days
    flex_base = max(1.0, base_hotel + base_food + base_ticket)

    # 若用户手动拉了预算上限，温和微调食宿标准去贴合
    target_total_mid = ((b_min + b_max) / 2.0) * pax
    if budget_max and target_total_mid > rigid_total + 200:
        scale = max(0.65, min(1.55, (target_total_mid - rigid_total) / flex_base))
    else:
        scale = 1.0

    hotel_room_unit = round(tier["hotel_room"] * scale / 10) * 10
    food_pp_unit = round(tier["food_pp"] * scale / 5) * 5
    ticket_pp_unit = round(tier["ticket_pp"] * scale / 5) * 5

    hotel = round(hotel_room_unit * rooms * nights)
    food = round(food_pp_unit * pax * days)
    ticket = round(ticket_pp_unit * pax * days)
    total = fuel + toll + hotel + food + ticket

    per_person: dict[str, int] = {}
    for n in range(1, 6):
        r_n = max(1, math.ceil(n / 2))
        t_n = (
            fuel
            + toll
            + round(hotel_room_unit * r_n * nights)
            + round(food_pp_unit * n * days)
            + round(ticket_pp_unit * n * days)
        )
        per_person[str(n)] = round(t_n / n)
    cur_pp = per_person[str(pax)]
    daily_pp = round(cur_pp / max(days, 1))
    living_daily_pp = round((cur_pp - rigid_pp) / max(days, 1))

    if cur_pp > b_max:
        diff = cur_pp - b_max
        status = "over"
        status_label = f"超出设定上限 ¥{diff}/人"
        saving_tip = (
            f"跨城车费（油电+过路费）人均分摊 ¥{rigid_pp}，吃住玩日均仅 ¥{living_daily_pp}/人·天；"
            f"若想压回上限，可切为「少走高速」立省 ¥{round(toll / pax)}/人，或多约 1~2 位同伴拼车。"
        )
    elif cur_pp < b_min:
        diff = b_min - cur_pp
        status = "under"
        status_label = f"比目标下限还省 ¥{diff}/人"
        saving_tip = f"当前吃住玩日均仅 ¥{living_daily_pp}/人·天，预算非常宽裕，目的地可升级景观房。"
    else:
        status = "fit"
        status_label = f"符合目标区间（日均吃住玩 ¥{living_daily_pp}/人·天）"
        saving_tip = f"标准清晰：{tier.get('desc','')}；高速用 ETC 还能再打 95 折。"

    items = [
        {
            "key": "fuel",
            "label": "充电补能" if energy == "ev" else "油费能耗",
            "color": "#0284c7",
            "amount": fuel,
            "formula": (
                f"全程 {round(distance_km)}km × ¥0.18/km ÷ {pax}人 = ¥{round(fuel / pax)}/人"
                if energy == "ev"
                else f"全程 {round(distance_km)}km × ¥0.58/km（约7.5L/百公里）÷ {pax}人 = ¥{round(fuel / pax)}/人"
            ),
            "tip": "服务区快充至 80% 最省时" if energy == "ev" else "进山区前在城郊加油站补满",
        },
        {
            "key": "toll",
            "label": "高速过路费",
            "color": "#6366f1",
            "amount": toll,
            "formula": (
                f"全程 {round(distance_km)}km × ¥0.42/km ÷ {pax}人 = ¥{round(toll / pax)}/人"
                if highway == "express"
                else "已选国道/少走高速，过路费 ¥0"
            ),
            "tip": "法定节假日免费通行可整笔省下",
        },
        {
            "key": "hotel",
            "label": f"沿途住宿（{nights}晚·{rooms}间）",
            "color": "#0d9488",
            "amount": hotel,
            "formula": f"¥{hotel_room_unit}/间·晚 × {nights}晚 × {rooms}间（折合 ¥{round(hotel / pax / nights)}/人·晚）",
            "tip": "2人拼标间最划算；赶路日住高速口连锁酒店",
        },
        {
            "key": "food",
            "label": f"地道三餐（{days}天）",
            "color": "#f59e0b",
            "amount": food,
            "formula": f"¥{food_pp_unit}/人·天 × {days}天 × {pax}人（早粉面+午简餐+晚老字号）",
            "tip": "避开景区门口拉客店，走 500 米进居民区老店",
        },
        {
            "key": "ticket",
            "label": "核心门票 & 机动",
            "color": "#ec4899",
            "amount": ticket,
            "formula": f"¥{ticket_pp_unit}/人·天 × {days}天 × {pax}人（每天仅 1 个付费锚点，其余免票街区）",
            "tip": "顺路可选站优先排免费古镇/公园，不花冤枉钱",
        },
    ]
    for it in items:
        it["pct"] = round((it["amount"] / max(total, 1)) * 100)

    return {
        "level": budget_level,
        "level_label": tier["label"],
        "level_desc": tier.get("desc", ""),
        "daily_range": list(tier.get("daily_range", (260, 420))),
        "highway": highway,
        "energy_type": energy,
        "pax": pax,
        "rooms": rooms,
        "hotel_room_unit": hotel_room_unit,
        "food_pp_unit": food_pp_unit,
        "ticket_pp_unit": ticket_pp_unit,
        "budget_min": b_min,
        "budget_max": b_max,
        "auto_min": auto_min,
        "auto_max": auto_max,
        "status": status,
        "status_label": status_label,
        "saving_tip": saving_tip,
        "distance_km": round(distance_km, 1),
        "nights": nights,
        "rigid_pp": rigid_pp,
        "living_daily_pp": living_daily_pp,
        "daily_per_person": daily_pp,
        "fuel": fuel,
        "toll": toll,
        "hotel": hotel,
        "food": food,
        "ticket": ticket,
        "total": total,
        "per_person": per_person,
        "items": items,
    }


def _build_checklist(
    distance_km: float,
    days: int,
    weather: dict[str, Any] | None,
    destination: str,
) -> list[dict[str, Any]]:
    texts = (weather or {}).get("texts") or []
    summary = str((weather or {}).get("summary") or "")
    rainy = any(re.search(r"雨|雪|雷", t) for t in texts) or bool(re.search(r"雨|雪|雷", summary))
    cold_spread = False
    highs = (weather or {}).get("highs") or []
    lows = (weather or {}).get("lows") or []
    try:
        if highs and lows and highs[0] is not None and lows[0] is not None:
            cold_spread = float(highs[0]) - float(lows[0]) >= 10
    except (TypeError, ValueError):
        pass
    high_altitude = destination in {"拉萨", "丽江", "香格里拉", "西宁", "格尔木", "敦煌"}
    items = [
        {"id": "license", "text": "驾驶证 / 行驶证 / 保险单", "group": "证件"},
        {"id": "phone_mount", "text": "手机支架与车载充电器", "group": "装备"},
        {"id": "cash_card", "text": "备用现金与常用银行卡", "group": "证件"},
        {"id": "meds", "text": "常用药品与创可贴", "group": "健康"},
    ]
    if distance_km >= 400:
        items.extend(
            [
                {"id": "tire", "text": "检查胎压、备胎与三角牌", "group": "车辆"},
                {"id": "washer", "text": "玻璃水与雨刮片状态", "group": "车辆"},
                {"id": "rest", "text": "每 2 小时休息 15 分钟计划", "group": "安全"},
            ]
        )
    if rainy:
        items.append({"id": "rain", "text": "雨具 / 防滑鞋 / 备用雨刷", "group": "天气"})
    if cold_spread or high_altitude:
        items.append({"id": "layers", "text": "冲锋衣与分层保暖衣物", "group": "天气"})
    if days >= 4:
        items.append({"id": "hotel_book", "text": "途经城市酒店提前预订", "group": "住宿"})
    if high_altitude:
        items.append({"id": "altitude", "text": "高原反应药与防晒", "group": "健康"})
    return items


def _pick_location(geo_text: str) -> str | None:
    try:
        data = json.loads(geo_text)
    except json.JSONDecodeError:
        m = re.search(r"\d+\.\d+,\d+\.\d+", geo_text)
        return m.group(0) if m else None

    for key in ("return", "geocodes", "pois", "tips", "results"):
        items = data.get(key) if isinstance(data, dict) else None
        if isinstance(items, list) and items:
            loc = items[0].get("location")
            if loc:
                return str(loc)
    if isinstance(data, dict) and data.get("location"):
        return str(data["location"])
    return None


def _format_distance(meters: Any) -> str:
    try:
        km = float(meters) / 1000.0
        return f"{km:.0f} 公里" if km >= 10 else f"{km:.1f} 公里"
    except (TypeError, ValueError):
        return str(meters or "—")


def _format_duration(seconds: Any) -> str:
    try:
        sec = float(seconds)
        hours = sec / 3600.0
        if hours >= 1:
            return f"{hours:.1f} 小时"
        return f"{int(sec / 60)} 分钟"
    except (TypeError, ValueError):
        return str(seconds or "—")


def _summarize_route(route_text: str) -> dict[str, str]:
    distance = "—"
    duration = "—"
    try:
        data = json.loads(route_text)
        paths = (((data.get("route") or {}).get("paths")) or [])
        if paths:
            distance = _format_distance(paths[0].get("distance"))
            duration = _format_duration(paths[0].get("duration"))
    except json.JSONDecodeError:
        m = re.search(r'"distance"\s*:\s*"?(\d+)"?', route_text)
        if m:
            distance = _format_distance(m.group(1))
        m = re.search(r'"duration"\s*:\s*"?(\d+)"?', route_text)
        if m:
            duration = _format_duration(m.group(1))
    return {"distance": distance, "duration": duration}


def _extract_polyline_points(route_text: str, max_points: int = 40) -> list[str]:
    """从驾车结果抽出 lng,lat 点串，抽稀后用于静态地图。"""
    points: list[str] = []
    try:
        data = json.loads(route_text)
        paths = (((data.get("route") or {}).get("paths")) or [])
        if not paths:
            return points
        steps = paths[0].get("steps") or []
        for step in steps:
            poly = step.get("polyline") or ""
            for part in str(poly).split(";"):
                part = part.strip()
                if re.match(r"^-?\d+(\.\d+)?,-?\d+(\.\d+)?$", part):
                    points.append(part)
    except json.JSONDecodeError:
        for m in re.finditer(r"(-?\d+\.\d+),(-?\d+\.\d+)", route_text):
            points.append(f"{m.group(1)},{m.group(2)}")

    if len(points) <= max_points:
        return points
    step = max(1, len(points) // max_points)
    sampled = points[::step][: max_points - 1]
    if points[-1] not in sampled:
        sampled.append(points[-1])
    return sampled


def parse_weather_series(weather_text: str, city: str = "") -> dict[str, Any]:
    """解析高德天气，输出图表序列 + 每日天气文案（供 Day 卡片图标/动效）。"""
    labels: list[str] = []
    highs: list[float | None] = []
    lows: list[float | None] = []
    texts: list[str] = []
    summary = "天气信息暂缺"
    try:
        data = json.loads(weather_text) if weather_text else {}
    except json.JSONDecodeError:
        data = {}

    forecasts = []
    if isinstance(data, dict):
        for key in ("forecasts", "forecast", "casts", "return", "lives"):
            val = data.get(key)
            if isinstance(val, list) and val:
                forecasts = val
                break
            if isinstance(val, dict):
                inner = val.get("casts") or val.get("forecasts") or []
                if inner:
                    forecasts = inner
                    break

    if forecasts and isinstance(forecasts[0], dict) and "casts" in forecasts[0]:
        city = forecasts[0].get("city") or city
        forecasts = forecasts[0].get("casts") or []

    for item in forecasts[:7]:
        if not isinstance(item, dict):
            continue
        day = item.get("date") or item.get("week") or item.get("day") or f"D{len(labels)+1}"
        # 实时天气 lives
        if "temperature" in item and "daytemp" not in item and "nighttemp" not in item:
            try:
                temp = float(str(item.get("temperature")).replace("℃", ""))
            except (TypeError, ValueError):
                continue
            labels.append(str(item.get("city") or city or "今日"))
            highs.append(temp)
            lows.append(temp)
            wx = str(item.get("weather") or "").strip()
            texts.append(wx)
            summary = f"{wx} {temp:.0f}°C".strip()
            continue
        try:
            high = float(str(item.get("daytemp") or item.get("day_temp") or item.get("max")).replace("℃", ""))
            low = float(str(item.get("nighttemp") or item.get("night_temp") or item.get("min")).replace("℃", ""))
        except (TypeError, ValueError):
            continue
        labels.append(str(day)[-5:] if len(str(day)) >= 5 else str(day))
        highs.append(high)
        lows.append(low)
        day_wx = str(
            item.get("dayweather")
            or item.get("day_weather")
            or item.get("weather")
            or ""
        ).strip()
        night_wx = str(item.get("nightweather") or item.get("night_weather") or "").strip()
        texts.append(day_wx or night_wx)

    if labels:
        if len(labels) == 1 and highs[0] is not None:
            summary = summary if summary != "天气信息暂缺" else f"{highs[0]:.0f}°C"
        else:
            valid_h = [x for x in highs if x is not None]
            valid_l = [x for x in lows if x is not None]
            if valid_h and valid_l:
                summary = f"{min(valid_l):.0f}~{max(valid_h):.0f}°C"
    return {
        "city": city,
        "summary": summary,
        "labels": labels,
        "highs": highs,
        "lows": lows,
        "texts": texts,
    }


async def fetch_static_map_data_url(
    origin_loc: str,
    dest_loc: str,
    polyline: list[str],
) -> str:
    """服务端请求高德静态地图，返回 data URL；失败返回空串。"""
    key = os.getenv("AMAP_MAPS_API_KEY", "").strip()
    if not key or not origin_loc or not dest_loc:
        return ""

    # paths=weight,color,transparency,lng1,lat1;lng2,lat2...
    path_pts = polyline[:] if polyline else [origin_loc, dest_loc]
    if origin_loc not in path_pts[:1]:
        path_pts = [origin_loc] + path_pts
    if dest_loc not in path_pts[-1:]:
        path_pts = path_pts + [dest_loc]
    # 静态图 paths 格式：10,0x0369A1,1,,:lng,lat;lng,lat
    coords = ";".join(path_pts[:60])
    paths = f"10,0x0369A1,1,,:{coords}"
    markers = f"mid,0x0EA5E9,起:{origin_loc}|mid,0x0369A1,终:{dest_loc}"
    url = (
        "https://restapi.amap.com/v3/staticmap"
        f"?size=900*520&scale=2&paths={quote(paths)}"
        f"&markers={quote(markers)}&key={key}"
    )
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(url)
            if resp.status_code != 200 or not resp.content:
                return ""
            ctype = resp.headers.get("content-type", "image/png")
            if "json" in ctype or resp.content[:1] == b"{":
                return ""
            b64 = base64.b64encode(resp.content).decode("ascii")
            return f"data:{ctype};base64,{b64}"
    except Exception:
        return ""


def _tavily_tool_name(tool_names: list[str]) -> str:
    for preferred in ("tavily-search", "search", "tavily_search"):
        if preferred in tool_names:
            return preferred
    return tool_names[0] if tool_names else "tavily-search"


def _pick_listed_web_image(text: str, city: str, name: str) -> str:
    """联网图只在结果同时提到这座城和这个站名时收下。对不上就留空。"""
    city_name = re.sub(r"[市省区县州]$", "", (city or "").strip())
    stop_name = (name or "").strip()
    if not text or not stop_name:
        return ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(data, dict):
        return ""
    blob_parts: list[str] = []
    images: list[tuple[str, str]] = []
    for item in data.get("results") or []:
        if not isinstance(item, dict):
            continue
        blob_parts.append(
            " ".join(str(item.get(key) or "") for key in ("title", "content", "url"))
        )
    for img in data.get("images") or []:
        if isinstance(img, str) and img.strip():
            images.append((img.strip(), ""))
        elif isinstance(img, dict):
            url = str(img.get("url") or img.get("image") or "").strip()
            desc = str(img.get("description") or img.get("title") or "")
            if url:
                images.append((url, desc))
    blob = " ".join(blob_parts)
    named = stop_name in blob or any(stop_name in desc for _, desc in images)
    in_city = (not city_name) or city_name in blob or any(city_name in desc for _, desc in images)
    if not named or not in_city:
        return ""
    for url, desc in images:
        if stop_name in desc and (not city_name or city_name in desc or city_name in blob):
            norm = _normalize_photo_url(url)
            if norm.startswith("https://"):
                return norm
    if stop_name in blob and (not city_name or city_name in blob) and images:
        norm = _normalize_photo_url(images[0][0])
        if norm.startswith("https://"):
            return norm
    return ""


def _reuse_list_images(new_trip: dict[str, Any], old_trip: dict[str, Any]) -> None:
    """改行程重排候选池时，把已经配上的联网图按城和站名带过去。"""
    found: dict[tuple[str, str], str] = {}

    def harvest(pool: list | None) -> None:
        for poi in pool or []:
            if not isinstance(poi, dict):
                continue
            url = str(poi.get("list_image") or "").strip()
            name = str(poi.get("name") or "").strip()
            if url and name:
                found[(str(poi.get("city") or ""), name)] = url

    harvest(old_trip.get("sight_pool"))
    for pool in (old_trip.get("city_pools") or {}).values():
        if isinstance(pool, dict):
            harvest(pool.get("sights"))

    def apply(pool: list | None) -> None:
        for poi in pool or []:
            if not isinstance(poi, dict) or poi.get("image") or poi.get("list_image"):
                continue
            url = found.get((str(poi.get("city") or ""), str(poi.get("name") or "")))
            if url:
                poi["list_image"] = url

    apply(new_trip.get("sight_pool"))
    for pool in (new_trip.get("city_pools") or {}).values():
        if isinstance(pool, dict):
            apply(pool.get("sights"))


async def fill_pool_list_images(trip: dict[str, Any]) -> dict[str, Any]:
    """高德没有照片的备选，用城市加站名搜一张。只写入 list_image，不进封面和海报。"""
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not api_key:
        return trip
    jobs: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    pools: list[list] = []
    if isinstance(trip.get("sight_pool"), list):
        pools.append(trip["sight_pool"])
    for pool in (trip.get("city_pools") or {}).values():
        if isinstance(pool, dict) and isinstance(pool.get("sights"), list):
            pools.append(pool["sights"])
    for sights in pools:
        for poi in sights:
            if not isinstance(poi, dict) or poi.get("image") or poi.get("list_image"):
                continue
            name = str(poi.get("name") or "").strip()
            city = str(poi.get("city") or trip.get("destination") or "").strip()
            key = (city, name)
            if not name or key in seen:
                continue
            seen.add(key)
            jobs.append(poi)
            if len(jobs) >= 4:
                break
        if len(jobs) >= 4:
            break
    if not jobs:
        return trip

    async def one(client: httpx.AsyncClient, poi: dict[str, Any]) -> None:
        city = str(poi.get("city") or trip.get("destination") or "")
        name = str(poi.get("name") or "")
        try:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": api_key,
                    "query": f"{city} {name}",
                    "max_results": 3,
                    "search_depth": "basic",
                    "include_images": True,
                    "include_image_descriptions": True,
                },
            )
            resp.raise_for_status()
            text = resp.text
        except Exception:
            return
        url = _pick_listed_web_image(text, city, name)
        if url:
            poi["list_image"] = url

    try:
        async with httpx.AsyncClient(timeout=6.0, trust_env=False) as client:
            await asyncio.wait_for(
                asyncio.gather(*(one(client, poi) for poi in jobs), return_exceptions=True),
                timeout=8.0,
            )
    except Exception:
        return trip
    return trip


def _first_image_url(text: str) -> str | None:
    # 常见：直接 URL，或 JSON 里的 images 字段
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            images = data.get("images") or []
            if images and isinstance(images[0], str):
                return images[0]
            results = data.get("results") or []
            for item in results:
                if isinstance(item, dict):
                    for key in ("image", "image_url", "thumbnail"):
                        if item.get(key):
                            return str(item[key])
    except json.JSONDecodeError:
        pass
    m = re.search(r"https?://[^\s\"']+\.(?:jpg|jpeg|png|webp)", text, re.I)
    return m.group(0) if m else None


async def _gather_amap_staged(
    origin: str,
    destination: str,
    progress: ProgressCb,
    stage: StageCb | None,
) -> dict[str, Any]:
    if not has_server("amap-maps"):
        raise RuntimeError("未配置 AMAP_MAPS_API_KEY，无法使用高德路线能力")

    progress("正在解析出发地与目的地坐标…")
    async with open_server_session("amap-maps") as amap:
        origin_loc = _cached_coord(origin)
        dest_loc = _cached_coord(destination)
        geo_tasks = []
        if not origin_loc:
            geo_tasks.append(("o", amap.call_tool("maps_geo", {"address": origin})))
        if not dest_loc:
            geo_tasks.append(("d", amap.call_tool("maps_geo", {"address": destination})))
        if geo_tasks:
            geo_res = await asyncio.gather(*(t for _, t in geo_tasks), return_exceptions=True)
            for (kind, _), val in zip(geo_tasks, geo_res):
                if isinstance(val, Exception):
                    continue
                loc = _pick_location(val)
                if kind == "o":
                    origin_loc = loc
                else:
                    dest_loc = loc
        if not origin_loc or not dest_loc:
            raise RuntimeError("无法解析出发地或目的地坐标，请换更具体的城市名重试")
        CITY_COORDS[origin] = origin_loc
        CITY_COORDS[destination] = dest_loc

        await _emit(
            stage,
            "geo",
            {
                "origin": origin,
                "destination": destination,
                "origin_location": origin_loc,
                "destination_location": dest_loc,
            },
        )

        progress("正在规划自驾路线与查询天气…")
        route, weather_raw, hero_poi, food_poi = await asyncio.gather(
            amap.call_tool(
                "maps_direction_driving",
                {"origin": origin_loc, "destination": dest_loc},
            ),
            amap.call_tool("maps_weather", {"city": destination}),
            amap.call_tool(
                "maps_text_search",
                {"keywords": f"{destination} 景点", "city": destination},
            ),
            amap.call_tool(
                "maps_text_search",
                {"keywords": f"{destination} 特色美食 小吃", "city": destination},
            ),
            return_exceptions=True,
        )
        if isinstance(route, Exception):
            raise RuntimeError(f"规划自驾路线失败: {route}")

        summary = _summarize_route(route)
        polyline = _extract_polyline_points(route, max_points=80)
        map_url = ""
        await _emit(
            stage,
            "route",
            {
                "distance": summary["distance"],
                "drive_hours": summary["duration"],
                "map_image": map_url,
                "origin": origin,
                "destination": destination,
                "origin_location": origin_loc,
                "destination_location": dest_loc,
                "polyline": polyline,
            },
        )

        weather_text = "" if isinstance(weather_raw, Exception) else weather_raw
        weather = parse_weather_series(weather_text, city=destination)
        await _emit(stage, "weather", weather)

        hero_image = (
            "" if isinstance(hero_poi, Exception) else (_amap_photo_url(hero_poi) or "")
        )
        # 取色绝不阻塞后续 itinerary：先用种子色板推送，后台再精修
        early_palette = _seed_palette(destination)
        await _emit(
            stage,
            "palette",
            {"palette": early_palette, "hero_image": hero_image},
        )
        if hero_image:

            async def _refine_palette() -> None:
                refined = await extract_palette_from_urls([hero_image])
                await _emit(
                    stage,
                    "palette",
                    {"palette": refined, "hero_image": hero_image},
                )

            asyncio.create_task(_refine_palette())

    return {
        "origin_location": origin_loc,
        "destination_location": dest_loc,
        "route_raw": route[:4000],
        "weather_raw": weather_text[:1500],
        "sights_raw": "" if isinstance(hero_poi, Exception) else hero_poi,
        "foods_raw": "" if isinstance(food_poi, Exception) else food_poi,
        "weather": weather,
        "map_image": map_url,
        "polyline": polyline,
        "distance": summary["distance"],
        "duration": summary["duration"],
        "palette": early_palette,
        "hero_image": hero_image,
    }


async def _gather_tavily(
    origin: str, destination: str, days: int, progress: ProgressCb
) -> str:
    if not has_server("tavily-mcp"):
        progress("未配置 Tavily，将仅基于路线信息生成行程")
        return ""

    progress("正在检索景点、美食与住宿攻略…")
    async with open_server_session("tavily-mcp") as tavily:
        query = f"{origin}到{destination}{days}天自驾 途经 景点 美食 住宿"
        try:
            return await asyncio.wait_for(
                tavily.call_tool(
                    "tavily-search",
                    {"query": query, "max_results": 3, "search_depth": "basic"},
                ),
                timeout=6.0,
            )
        except Exception:
            return ""


_TRIP_CACHE: dict[tuple, dict[str, Any]] = {}


def _normalize_photo_url(url: str | None) -> str:
    """统一高德图片为 https，避免混合内容与防盗链失败。"""
    if not url:
        return ""
    u = str(url).strip()
    if not u:
        return ""
    if u.startswith("//"):
        u = "https:" + u
    elif u.startswith("http://"):
        u = "https://" + u[len("http://") :]
    return u


def _parse_pois(text: str, limit: int = 18, center_loc: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not text:
        return out
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return out
    pois = data.get("pois") or data.get("return") or []
    if not isinstance(pois, list):
        return out
    center_pt = _parse_loc(center_loc) if center_loc else None
    for p in pois:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        address = str(p.get("address") or "").strip()
        location = str(p.get("location") or "").strip()
        adname = str(p.get("adname") or p.get("adcode") or "").strip()
        if adname.isdigit():
            adname = ""
        if not adname and address:
            m = re.match(r"^([\u4e00-\u9fa5]{2,5}(?:区|县|市))", address)
            if m:
                adname = m.group(1)
        is_county = bool(adname and (adname.endswith("县") or adname.endswith("市")))
        if not is_county and center_pt and location:
            pt = _parse_loc(location)
            if pt and _haversine_km(center_pt, pt) >= 24.0:
                is_county = True
        photo = ""
        photos = p.get("photos")
        if isinstance(photos, dict) and photos.get("url"):
            u = photos["url"]
            photo = str(u[0] if isinstance(u, list) and u else u)
        elif isinstance(photos, list) and photos:
            first = photos[0]
            photo = str(first.get("url") if isinstance(first, dict) else first)
        photo = _normalize_photo_url(photo)
        biz = p.get("biz_ext") if isinstance(p.get("biz_ext"), dict) else {}
        rating = str(biz.get("rating") or p.get("rating") or "").strip()
        if rating in {"[]", "None"}:
            rating = ""
        cost = str(biz.get("cost") or p.get("cost") or "").strip()
        if cost in {"[]", "None"}:
            cost = ""
        tag = str(p.get("type") or p.get("tag") or "").split(";")[0].strip()
        stop_kind = "food" if ("餐" in tag or "美食" in tag or "小吃" in tag) else "sight"
        human_tags = _human_tags_for_poi(name, tag, rating, cost, adname, is_county, stop_kind)
        item: dict[str, Any] = {
            "name": name,
            "address": address,
            "image": photo,
            "location": location,
            "rating": rating,
            "cost": cost,
            "tag": tag,
            "district": adname,
            "is_county": is_county,
            "human_tags": human_tags,
            "stay_hours": 2.5 if is_county else (2.0 if "风景" in tag or "名胜" in tag or "公园" in tag else 1.5),
        }
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _poi_to_stop(
    poi: dict[str, Any],
    time: str,
    stop_type: str,
    city: str,
    priority: str = "must",
) -> dict[str, Any]:
    stay = poi.get("stay_hours") or (1.5 if stop_type == "food" else 2.0)
    is_county = bool(poi.get("is_county"))
    district = str(poi.get("district") or "").strip()
    if stop_type == "sight":
        if priority == "anchor":
            detail = (
                f"【今日核心锚点】{district or city}必去代表站，建议预留 {stay:g} 小时深度游览，上午光线与人流最佳。"
            )
        elif is_county:
            detail = f"顺路宝藏县域（{district or city}），离主城稍远但体验地道，建议预留 {stay:g} 小时。"
        elif priority == "optional":
            detail = f"弹性顺路站（体力好再去，累了可直接在附近咖啡馆休息），约 {stay:g} 小时。"
        else:
            detail = f"{city}人气打卡地，建议预留 {stay:g} 小时游览拍照。"
    else:
        detail = "当地人常去的风味店，饭点建议提前取号或错峰半小时。"
    it: dict[str, Any] = {
        "time": time,
        "type": stop_type,
        "priority": priority,
        "title": poi.get("name") or city,
        "place": poi.get("address") or city,
        "city": city,
        "district": district,
        "is_county": is_county,
        "human_tags": poi.get("human_tags") or [],
        "detail": detail,
        "stay_hours": stay,
        "id": f"{stop_type}-{(poi.get('location') or poi.get('name') or time)}",
    }
    if poi.get("image"):
        it["image"] = poi["image"]
    if poi.get("location"):
        it["location"] = poi["location"]
    if poi.get("rating"):
        it["rating"] = poi["rating"]
    if poi.get("cost"):
        it["cost"] = poi["cost"]
    if poi.get("tag"):
        it["tag"] = poi["tag"]
    return it


def _free_time_stop(city: str, theme: str, district: str = "") -> dict[str, Any]:
    area = district or f"{city}老街/公园"
    hint_map = {
        "landmark": f"在{area}找家坝坝茶或观景咖啡馆歇脚，等傍晚柔和光线再出门。",
        "family": f"回酒店午休或带娃在{area}草坪自由放电，不赶场。",
        "photo": f"留给黄金时刻（16:30–17:45）在{area}街头抓拍光影与市井人文。",
        "food": f"留白消食时间，在{area}菜市场或小巷逛逛，顺手买点水果卤味。",
    }
    return {
        "time": "16:00",
        "type": "free",
        "priority": "free",
        "title": f"留白 · {area}自由慢逛",
        "place": area,
        "city": city,
        "district": district,
        "detail": hint_map.get(theme, hint_map["landmark"]),
        "stay_hours": 1.5,
        "id": f"free-{city}-{district or 'relax'}",
    }


def _build_fit_verdict(
    distance_km: float,
    days: int,
    transit_days: int,
    pace: str,
    theme_label: str,
    weather: dict[str, Any] | None,
) -> dict[str, Any]:
    avg_transit_km = round(distance_km / max(transit_days, 1)) if transit_days else round(distance_km / max(days, 1))
    pace_cn = {"relaxed": "轻松慢游", "balanced": "经典均衡", "hardcore": "特种兵"}[pace]
    best_for = f"偏爱「{theme_label}」、接受前 {transit_days or 1} 天日均约 {avg_transit_km}km 分段推进的 2–4 人自驾同伴"
    if transit_days == 0 or distance_km < 350:
        best_for = f"想周末/短途围绕「{theme_label}」深度慢逛、讨厌每天换酒店的朋友"
    if pace == "hardcore" or avg_transit_km >= 550:
        skip_if = "车上有易晕车老人/低龄儿童，或只有 1 名司机的队伍（建议切回轻松慢游或高铁落地租车）"
    elif transit_days >= 3:
        skip_if = "假期少于 5 天或只想躺平度假的同伴（长途跨省有连日开车段，建议至少 2 名司机轮换）"
    elif pace == "relaxed":
        skip_if = "按轻松慢游排，下午留白，不赶打卡"
    else:
        skip_if = "想一天塞满打卡、不愿留白的玩法（本方案每天下午留白）"

    texts = (weather or {}).get("texts") or []
    summary = str((weather or {}).get("summary") or "多云")
    highs = (weather or {}).get("highs") or []
    lows = (weather or {}).get("lows") or []
    temp_note = ""
    try:
        if highs and lows and highs[0] is not None and lows[0] is not None:
            temp_note = f"近期 {int(lows[0])}°~{int(highs[0])}°C，"
    except Exception:
        pass
    season_tip = f"{temp_note}{summary}为主，早晚车内外温差大，备一件防风外套放后座随手拿。"
    if any("雨" in t for t in texts) or "雨" in summary:
        season_tip = f"{temp_note}沿途有雨，高速与盘山段务必降速，热门室外机位建议顺移到晴天上午。"
    return {
        "best_for": best_for,
        "skip_if": skip_if,
        "season_tip": season_tip,
        "pace_label": pace_cn,
    }


def _rail_city_key(name: str) -> str:
    text = str(name or "").strip()
    return re.sub(r"(?:市|省|自治区|自治州|地区|盟)$", "", text) or text


def _day_nums(days_plan: list[dict[str, Any]], kinds: set[str] | None = None) -> list[int]:
    out: list[int] = []
    for d in days_plan or []:
        if kinds and (d.get("kind") or "") not in kinds:
            continue
        try:
            out.append(int(d.get("day") or 0))
        except (TypeError, ValueError):
            continue
    return [n for n in out if n > 0]


def _build_pitfalls(
    origin: str,
    destination: str,
    distance_km: float,
    transit_days: int,
    weather: dict[str, Any] | None,
    has_county: bool,
    days_plan: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    plan = days_plan or []
    dest = _rail_city_key(destination)
    explore = _day_nums(plan, {"explore", "county"}) or _day_nums(plan)
    transit = _day_nums(plan, {"transit"})
    county = _day_nums(plan, {"county"})
    first_explore = explore[0] if explore else None
    first_transit = transit[0] if transit else None
    first_county = county[0] if county else first_explore

    pitfalls: list[dict[str, Any]] = [
        {
            "pit": f"中午 11:30–14:00 扎堆进{destination}核心景区与网红老街",
            "why": "旅游团与一日游大巴集中抵达，停车场排队动辄 40 分钟且顶光拍照发灰",
            "fix": "把「今日必去锚点」固定放在 09:30 前入园；正午去附近居民区吃饭或回酒店休整",
            "city": dest,
            "day": first_explore,
        },
        {
            "pit": "直接在景区门口或仿古商业街主街吃正餐",
            "why": "溢价高且多为预制流水席，排队久体验差",
            "fix": "顺着路书里的美食卡导航出景区 1–2 公里，找停满本地车牌的社区老店，或点「小红书实况」看当周避雷",
            "city": dest,
            "day": first_explore,
        },
    ]
    if distance_km >= 600 or transit_days >= 2:
        pitfalls.append(
            {
                "pit": "赶路日傍晚 18:00 后还在跑陌生山路或进大城晚高峰",
                "why": "视线变差 + 货车变多 + 城际高速入口极易拥堵，疲劳感翻倍",
                "fix": "严守「早上 08:00 出发、17:00 前进落脚城」原则；余量剩 1/4 油就进服务区补满",
                "city": _rail_city_key(origin) if first_transit else "",
                "day": first_transit,
                "scope": "transit",
            }
        )
    if has_county:
        pitfalls.append(
            {
                "pit": "把郊县宝藏景点（如都江堰/三星堆/临潼/阳朔）和市区大点混排在同一天折返",
                "why": "单程出城就要 1–1.5 小时，来回折腾半天全耗在路上",
                "fix": "本路书已将县域站点独立成组；当天就住县城或顺路进出，绝不走回头路",
                "city": dest,
                "day": first_county,
            }
        )
    texts = (weather or {}).get("texts") or []
    if any(re.search(r"雨|雾|雪", t) for t in texts):
        pitfalls.append(
            {
                "pit": "雨雾天死磕山顶观景台或峡谷游船",
                "why": "能见度低白跑一趟，且县道湿滑易封路",
                "fix": "出发前点卡片「小红书实况」看当天早间游客实拍；起雾立刻用「换一换」切到博物馆/古建室内站",
                "city": "",
                "day": None,
                "scope": "all",
            }
        )
    else:
        pitfalls.append(
            {
                "pit": "到门口才买热门博物院/遗产景区门票",
                "why": "周末与旺季基本提前 3–5 天售罄，现场无票可买",
                "fix": "凡带 #必提前预约 标签的锚点站，定下行程当天就去官方公众号锁票",
                "city": dest,
                "day": first_explore,
            }
        )
    return pitfalls[:4]


def _annotate_rail_items(
    days_plan: list[dict[str, Any]],
    foods: list[dict[str, Any]],
    hotels: list[dict[str, Any]],
    destination: str,
) -> None:
    """给必吃/住宿挂 day 或 city，方便右栏按天筛选。"""
    dest = _rail_city_key(destination)
    city_to_days: dict[str, list[int]] = {}
    for d in days_plan or []:
        try:
            day_no = int(d.get("day") or 0)
        except (TypeError, ValueError):
            continue
        if day_no <= 0:
            continue
        for raw in (d.get("stay_city"), d.get("to_city"), d.get("from_city")):
            key = _rail_city_key(str(raw or ""))
            if not key:
                continue
            city_to_days.setdefault(key, [])
            if day_no not in city_to_days[key]:
                city_to_days[key].append(day_no)
    explore_days = _day_nums(days_plan or [], {"explore", "county"}) or _day_nums(days_plan or [])
    dest_days = city_to_days.get(dest) or explore_days

    for i, food in enumerate(foods or []):
        city = _rail_city_key(str(food.get("city") or ""))
        if not city:
            place = str(food.get("place") or "")
            for key in city_to_days:
                if key and key in place:
                    city = key
                    break
        if not city:
            city = dest
        food["city"] = city
        if not food.get("day"):
            days = city_to_days.get(city) or dest_days
            food["day"] = days[i % len(days)] if days else None

    for hotel in hotels or []:
        place = str(hotel.get("place") or hotel.get("name") or "")
        city = _rail_city_key(str(hotel.get("city") or ""))
        if not city:
            for key in city_to_days:
                if key and key in place:
                    city = key
                    break
        if not city:
            city = dest
        days = city_to_days.get(city) or dest_days
        hotel["city"] = city
        if not hotel.get("day"):
            hotel["day"] = days[-1] if days else None


def _estimate_route_fallback(
    origin: str,
    destination: str,
    origin_loc: str,
    dest_loc: str,
) -> dict[str, Any]:
    """高德驾车结果缺失时，用球面距离 × 1.3 估算路网里程，并连成城市折线。"""
    o = _parse_loc(origin_loc)
    d = _parse_loc(dest_loc)
    if not o or not d:
        return {"distance_km": 0.0, "duration_h": 0.0, "polyline": [], "distance": "—", "duration": "—"}
    straight = _haversine_km(o, d)
    road_km = max(straight * 1.3, straight + 80)
    hours = road_km / 78.0
    # 在起终点之间插值，吸附到附近城市，形成粗折线
    samples = max(4, min(10, int(road_km / 220) + 2))
    pts: list[str] = [origin_loc]
    used = {
        re.sub(r"[市省区县]$", "", origin.strip()),
        re.sub(r"[市省区县]$", "", destination.strip()),
    }
    for i in range(1, samples):
        t = i / samples
        lng = o[0] + (d[0] - o[0]) * t
        lat = o[1] + (d[1] - o[1]) * t
        city = _nearest_city(lng, lat, exclude=used, max_km=180.0)
        if city:
            used.add(city)
            pts.append(CITY_COORDS[city])
        else:
            pts.append(f"{lng:.6f},{lat:.6f}")
    pts.append(dest_loc)
    # 去重相邻重复点
    compact: list[str] = []
    for p in pts:
        if not compact or compact[-1] != p:
            compact.append(p)
    return {
        "distance_km": round(road_km, 1),
        "duration_h": round(hours, 1),
        "polyline": compact,
        "distance": _format_distance(road_km * 1000),
        "duration": _format_duration(hours * 3600),
    }


_LEG_CACHE: dict[tuple[str, str], tuple[float, float, list[str]]] = {}


def _long_drive_hint(trip: dict[str, Any], pace: str) -> str:
    """途经城锁定后不再自动补城，单日车程明显超出节奏上限时给一句提醒。"""
    limit = PACE_DAILY_KM.get(pace, 600.0) * 1.3
    worst = max(
        (d for d in trip.get("days_plan") or [] if float(d.get("drive_km") or 0) > limit),
        key=lambda d: float(d.get("drive_km") or 0),
        default=None,
    )
    if not worst:
        return ""
    return (
        f"提醒：DAY {worst.get('day')} {worst.get('from_city') or ''}→{worst.get('to_city') or ''} "
        f"单日车程约 {float(worst.get('drive_km') or 0):.0f} 公里，可在中间加一个途经城分担"
    )


async def _reroute_stub(
    amap_stub: dict[str, Any],
    origin: str,
    destination: str,
    custom_via: list[str],
    exclude_via: set[str] | None = None,
) -> list[float] | None:
    """途经列表由用户锁定时，按剩余城市重新请求真实路线并写回 amap_stub，返回逐段里程。"""
    def _c(x: str) -> str:
        return re.sub(r"[市省区县]$", "", x.strip()) or x.strip()

    o, d = _c(origin), _c(destination)
    skip = {o, d} | {_c(x) for x in (exclude_via or set()) if x}
    mids: list[str] = []
    for c in custom_via:
        cc = _c(c)
        if cc and cc not in skip and cc not in mids and _cached_coord(cc):
            mids.append(cc)
    routed = await _route_through_cities([o, *mids, d])
    if not routed:
        return None
    amap_stub["distance"] = routed["distance"]
    amap_stub["duration"] = routed["duration"]
    amap_stub["polyline"] = routed["polyline"]
    return routed["leg_km"]


async def _route_through_cities(cities: list[str]) -> dict[str, Any] | None:
    """按「起点 → 途经城… → 终点」逐段调用高德驾车（MCP 不支持 waypoints），拼出全程里程/车时/折线。

    任一城市缺坐标或任一段失败时返回 None，由调用方退回球面估算。
    """
    locs = [_cached_coord(re.sub(r"[市省区县]$", "", c.strip()) or c) for c in cities]
    if len(locs) < 2 or not all(locs) or not has_server("amap-maps"):
        return None
    pairs = list(zip(locs[:-1], locs[1:]))
    missing = [p for p in dict.fromkeys(pairs) if p not in _LEG_CACHE]
    if missing:
        try:
            async with open_server_session("amap-maps") as amap:
                results = await asyncio.wait_for(
                    asyncio.gather(
                        *(
                            amap.call_tool("maps_direction_driving", {"origin": a, "destination": b})
                            for a, b in missing
                        ),
                        return_exceptions=True,
                    ),
                    timeout=20,
                )
        except Exception:
            return None
        for pair, res in zip(missing, results):
            if isinstance(res, Exception):
                return None
            try:
                path = ((json.loads(res).get("route") or {}).get("paths") or [])[0]
                meters, seconds = float(path["distance"]), float(path["duration"])
            except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                return None
            if meters <= 0:
                return None
            _LEG_CACHE[pair] = (meters / 1000.0, seconds, _extract_polyline_points(res, max_points=30))

    leg_km: list[float] = []
    total_s = 0.0
    polyline: list[str] = []
    for pair in pairs:
        km, sec, pts = _LEG_CACHE[pair]
        leg_km.append(round(km, 1))
        total_s += sec
        seg_pts = pts or list(pair)
        polyline.extend(seg_pts[1:] if polyline and seg_pts and seg_pts[0] == polyline[-1] else seg_pts)
    total_km = sum(leg_km)
    return {
        "leg_km": leg_km,
        "distance": _format_distance(total_km * 1000),
        "duration": _format_duration(total_s),
        "polyline": polyline,
    }


def _build_fast_itinerary(
    origin: str,
    destination: str,
    days: int,
    amap: dict[str, Any],
    pace: str = "balanced",
    theme: str = "landmark",
    budget_level: str = "comfort",
    highway: str = "express",
    custom_via: list[str] | None = None,
    exclude_via: set[str] | None = None,
    budget_min: int | None = None,
    budget_max: int | None = None,
    pax: int = 2,
    energy_type: str = "oil",
    fill_via: bool = True,
    leg_km: list[float] | None = None,
    start_date: str = "",
    travel_mode: str = "drive",
) -> dict[str, Any]:
    """无需等待 LLM，直接用高德路线 + 途经城市切分 + POI 候选池构建可交付路书。

    leg_km 存在时，amap 里的 distance/duration 已是按途经城逐段实测的全程数据，不再按球面距离重估。
    """
    weather = amap.get("weather") or {}
    dest_loc = amap.get("destination_location") or _cached_coord(destination) or ""
    sight_pool = list(amap.get("sight_pool") or _parse_pois(amap.get("sights_raw") or "", limit=18, center_loc=dest_loc))
    food_pool = list(amap.get("food_pool") or _parse_pois(amap.get("foods_raw") or "", limit=12, center_loc=dest_loc))
    # 注入目的地顺路宝藏卫星县到候选池（当高德默认只给主城区时，补足县域精华）
    dest_clean = re.sub(r"[市省区县州]$", "", destination.strip())
    gems = SATELLITE_GEMS.get(dest_clean) or []
    existing_names = {s["name"] for s in sight_pool}
    for g in gems:
        if g["sight"] not in existing_names:
            sight_pool.append(
                {
                    "name": g["sight"],
                    "address": g["place"],
                    "image": "",
                    "location": g["location"],
                    "rating": "4.9",
                    "cost": "",
                    "tag": "宝藏县域",
                    "district": g["county"],
                    "is_county": True,
                    "human_tags": [f"#宝藏县域·{g['county']}"] + g["tag"].split(),
                    "stay_hours": 3.0,
                }
            )
        if g.get("food"):
            food_pool.append(
                {
                    "name": g["food"],
                    "address": g.get("food_place") or g["county"],
                    "image": "",
                    "location": g["location"],
                    "rating": "4.8",
                    "cost": "55",
                    "tag": "县城老店",
                    "district": g["county"],
                    "is_county": True,
                    "human_tags": [f"#{g['county']}地道味", "#顺路必吃"],
                    "stay_hours": 1.5,
                }
            )
    distance_km = _distance_km_from_text(amap.get("distance"))
    duration_h = _duration_hours_from_text(amap.get("duration"))
    polyline = list(amap.get("polyline") or [])
    distance_label = amap.get("distance") or "—"
    duration_label = amap.get("duration") or "—"

    # 驾车结果缺失时用坐标估算，避免全部变成「目的地游」
    if (distance_km <= 1 or not polyline) and amap.get("origin_location") and amap.get("destination_location"):
        fb = _estimate_route_fallback(
            origin,
            destination,
            amap.get("origin_location") or "",
            amap.get("destination_location") or "",
        )
        if fb["distance_km"] > distance_km:
            distance_km = fb["distance_km"]
            duration_h = fb["duration_h"]
            distance_label = fb["distance"]
            duration_label = fb["duration"]
        if not polyline:
            polyline = fb["polyline"]

    daily_km = PACE_DAILY_KM.get(pace, 600.0)
    stops_per_day = PACE_STOPS.get(pace, 3)
    theme_label = THEME_LABELS.get(theme, "经典地标")

    transit_days = 0
    if distance_km > daily_km * 0.55 and days >= 2:
        transit_days = min(days - 1, max(1, math.ceil(distance_km / daily_km)))
    if custom_via:
        transit_days = min(days - 1, max(transit_days, len(custom_via) + 1))
    explore_days = max(0, days - transit_days)
    via_nodes = _match_via_cities(
        polyline,
        origin,
        destination,
        transit_days,
        distance_km,
        custom_via=custom_via,
        exclude_via=exclude_via,
        fill_via=fill_via,
        leg_km=leg_km,
    )
    via_names = [n["name"] for n in via_nodes]
    routed = bool(leg_km) and len(leg_km) == len(via_nodes) - 1
    # 有逐段高德实测时，里程已写在 amap.distance 里。没有实测时，不用球面累加覆盖原里程。
    if routed:
        if not polyline or len(polyline) < len(via_nodes):
            polyline = [n["location"] for n in via_nodes if n.get("location")]
    elif custom_via and len(via_nodes) >= 2 and not polyline:
        polyline = [n["location"] for n in via_nodes if n.get("location")]
    # 对齐 transit_days 与实际中间落脚段数（len(via_nodes)-1）
    if len(via_nodes) >= 2:
        transit_days = min(days - 1, len(via_nodes) - 1)
        explore_days = max(0, days - transit_days)

    days_plan: list[dict[str, Any]] = []
    for sp in sight_pool:
        sp.setdefault("city", dest_clean)
    for fp in food_pool:
        fp.setdefault("city", dest_clean)
    urban_sights = [s for s in sight_pool if not s.get("is_county")]
    county_sights = [s for s in sight_pool if s.get("is_county")]
    # 为每个途经城构建专属候选池，供首排与前端「换一换」按城取用，绝不跨城串味
    city_pools: dict[str, dict[str, list[dict[str, Any]]]] = {
        dest_clean: {"sights": sight_pool, "foods": food_pool},
        destination: {"sights": sight_pool, "foods": food_pool},
    }
    for cname in via_names:
        c_clean = re.sub(r"[市省区县州]$", "", cname.strip()) or cname
        if c_clean not in city_pools:
            pool_c = _build_city_candidate_pool(c_clean)
            city_pools[c_clean] = pool_c
            city_pools[cname] = pool_c

    sight_idx = 0
    county_idx = 0
    food_idx = 0
    used_sight_names: set[str] = set()
    used_food_names: set[str] = set()
    has_county_scheduled = False

    def next_sight(
        city: str,
        prefer_county: bool = False,
        prefer_district: str = "",
        *,
        strict_district: bool = False,
    ) -> dict[str, Any] | None:
        nonlocal sight_idx, county_idx, has_county_scheduled
        c_clean = re.sub(r"[市省区县州]$", "", city.strip()) or city
        # 0) 途经非目的地城市：从该城专属 city_pools 取，保证点「换一换」时同城可轮换且不拿目的地的点
        if c_clean != dest_clean:
            c_pool = (city_pools.get(c_clean) or _build_city_candidate_pool(c_clean))["sights"]
            for sp in c_pool:
                if sp["name"] not in used_sight_names:
                    used_sight_names.add(sp["name"])
                    if sp.get("is_county"):
                        has_county_scheduled = True
                    return sp
            return c_pool[0]
        # 1) 若指定同区县，优先找同区县未用过的点（防折返）
        if prefer_district:
            for sp in sight_pool:
                if sp["name"] not in used_sight_names and sp.get("district") == prefer_district:
                    used_sight_names.add(sp["name"])
                    if sp.get("is_county"):
                        has_county_scheduled = True
                    return sp
            if strict_district:
                return None
        # 2) 若今天是郊县宝藏日，优先取县域点
        if prefer_county:
            while county_idx < len(county_sights):
                sp = county_sights[county_idx]
                county_idx += 1
                if sp["name"] in used_sight_names:
                    continue
                used_sight_names.add(sp["name"])
                has_county_scheduled = True
                return sp
        # 3) 常规主城区点
        while sight_idx < len(urban_sights):
            sp = urban_sights[sight_idx]
            sight_idx += 1
            if sp["name"] in used_sight_names:
                continue
            used_sight_names.add(sp["name"])
            return sp
        # 4) 兜底从全池找
        for sp in sight_pool:
            if sp["name"] not in used_sight_names:
                used_sight_names.add(sp["name"])
                return sp
        vibe = _city_vibe(city)
        return {
            "name": f"{city}老城街巷漫步",
            "address": f"{city}历史文化街区",
            "image": "",
            "location": _cached_coord(city) or "",
            "rating": "4.7",
            "cost": "",
            "tag": "人文街区",
            "district": "",
            "is_county": False,
            "human_tags": [f"#{vibe['tags'][0]}", "#免门票"],
            "stay_hours": 1.5,
        }

    def next_food(city: str, prefer_district: str = "") -> dict[str, Any]:
        nonlocal food_idx
        c_clean = re.sub(r"[市省区县州]$", "", city.strip()) or city
        if prefer_district:
            for fp in food_pool:
                if fp.get("district") == prefer_district and fp["name"] not in used_food_names:
                    used_food_names.add(fp["name"])
                    return fp
        if c_clean != dest_clean:
            c_foods = (city_pools.get(c_clean) or _build_city_candidate_pool(c_clean))["foods"]
            for fp in c_foods:
                if fp["name"] not in used_food_names:
                    used_food_names.add(fp["name"])
                    return fp
            return c_foods[0]
        if food_pool:
            urban_foods = [f for f in food_pool if not f.get("is_county")] or food_pool
            fp = urban_foods[food_idx % len(urban_foods)]
            food_idx += 1
            return fp
        return {
            "name": f"{city}地道老店",
            "address": f"{city}主城区",
            "image": "",
            "location": _cached_coord(city) or "",
            "rating": "4.7",
            "cost": "60",
            "tag": "美食",
            "district": "",
            "is_county": False,
            "human_tags": ["#本地人扎堆"],
            "stay_hours": 1.5,
        }

    for d in range(1, days + 1):
        items: list[dict[str, Any]] = []
        if d <= transit_days:
            # 赶路日：从 via_nodes[d-1] → via_nodes[d]
            start_n = via_nodes[min(d - 1, len(via_nodes) - 1)]
            end_n = via_nodes[min(d, len(via_nodes) - 1)]
            seg_km = max(0.0, float(end_n.get("cum_km") or 0) - float(start_n.get("cum_km") or 0))
            if seg_km <= 0 and distance_km and transit_days:
                seg_km = distance_km / transit_days
            seg_hours = (seg_km / distance_km * duration_h) if distance_km and duration_h else seg_km / 80.0
            stay_city = end_n["name"]
            vibe = _city_vibe(stay_city)
            title = f"{start_n['name']} → {stay_city}"
            summary = (
                f"今日推进约 {seg_km:.0f}km（约 {seg_hours:.1f}h），傍晚抵达「{'·'.join(vibe['tags'][:2])}」{stay_city}，"
                f"卸下行李去吃顿热乎的{vibe['bite']}。"
            )
            items.append(
                {
                    "time": "08:00",
                    "type": "drive",
                    "priority": "anchor",
                    "title": f"{start_n['name']} 启程 → {stay_city}",
                    "place": f"{start_n['name']} → {stay_city}",
                    "city": stay_city,
                    "location": end_n.get("location") or _cached_coord(stay_city) or "",
                    "human_tags": ["#高速主干线" if highway == "express" else "#风景省道", "#每2h进服务区"],
                    "detail": f"分段约 {seg_km:.0f} 公里 · 预计驾驶 {seg_hours:.1f} 小时，建议 17:00 前进城落脚避免夜路。",
                    "id": f"drive-{d}",
                }
            )
            # 途经节点若在平遥/太原等宝藏县域附近，优先给顺路古建/地标做弹性站
            sp = next_sight(stay_city)
            items.append(_poi_to_stop(sp, "17:00", "sight", stay_city, priority="optional"))
            fp = next_food(stay_city)
            items.append(_poi_to_stop(fp, "19:00", "food", stay_city, priority="must"))
            day_meta = {
                "kind": "transit",
                "from_city": start_n["name"],
                "to_city": stay_city,
                "drive_km": round(seg_km, 1),
                "drive_hours": round(seg_hours, 1),
                "stay_city": stay_city,
                "city_vibe": vibe,
            }
        else:
            # 目的地游玩日：第 2 个游玩日起若有顺路宝藏郊县，独立排一天「郊县日」不折返
            explore_i = d - transit_days
            use_county_day = bool(county_sights and explore_i == 2 and explore_days >= 2)
            anchor_sp = next_sight(destination, prefer_county=use_county_day)
            day_district = anchor_sp.get("district") or ""
            is_county_day = bool(anchor_sp.get("is_county"))
            vibe = _city_vibe(destination)

            if is_county_day and day_district:
                title = f"{destination}郊县宝藏 · {day_district}慢游"
                summary = f"今天不回市区折腾，专程拿下一整天探索{day_district}，顺路吃当地老字号。"
            elif explore_i == explore_days and days >= 3:
                title = f"{destination}收官 · 满载回味"
                summary = f"在{destination}轻松收尾，买点伴手礼、喝杯下午茶再返程。"
            elif explore_i == 1:
                if pace == "relaxed":
                    title = f"{destination}抵达 · 第{d}天慢慢逛"
                    summary = f"初见{destination}（{'·'.join(vibe['tags'])}），按轻松慢游先拿下一处锚点，下午留白。"
                else:
                    title = f"{destination}抵达 · 第{d}天主线"
                    summary = f"初见{destination}（{'·'.join(vibe['tags'])}），先拿下一处核心锚点与地道老店。"
            else:
                title = f"{destination}深度漫游 · {day_district or f'第{d}天'}"
                summary = f"按「{theme_label}」节奏同片区顺路逛，拒绝跨城折返跑。"

            # 1) 上午：全天唯一的必去锚点（Anchor）
            items.append(_poi_to_stop(anchor_sp, "09:30", "sight", destination, priority="anchor"))

            # 2) 下午：同片区/同区县的弹性可选站（Optional）
            opt_count = 2 if stops_per_day >= 4 else 1
            for slot in ["14:00", "15:30"][:opt_count]:
                sp_opt = next_sight(
                    destination,
                    prefer_county=is_county_day,
                    prefer_district=day_district,
                    strict_district=bool(is_county_day and day_district),
                )
                if sp_opt:
                    items.append(_poi_to_stop(sp_opt, slot, "sight", destination, priority="optional"))

            # 3) 傍晚前：博主式刻意留白（Free time），除非是特种兵模式
            if pace != "hardcore":
                items.append(_free_time_stop(destination, theme, day_district))

            # 4) 晚餐：同区县优先的烟火美食
            fp = next_food(destination, prefer_district=day_district)
            items.append(_poi_to_stop(fp, "18:30", "food", destination, priority="must"))
            day_meta = {
                "kind": "county" if is_county_day else "explore",
                "from_city": destination,
                "to_city": day_district or destination,
                "drive_km": 55.0 if is_county_day else 0,
                "drive_hours": 1.0 if is_county_day else 0,
                "stay_city": day_district if is_county_day else destination,
                "district": day_district,
                "city_vibe": vibe,
            }

        days_plan.append(
            {
                "day": d,
                "title": title,
                "summary": summary,
                "items": items,
                **day_meta,
            }
        )

    foods = [
        {
            "name": f["name"],
            "place": f.get("address") or destination,
            "note": "高德人气风味",
            "rating": f.get("rating") or "",
            "cost": f.get("cost") or "",
            "location": f.get("location") or "",
            **({"image": f["image"]} if f.get("image") else {}),
        }
        for f in food_pool[:6]
    ] or [
        {"name": f"{destination}地道老店", "place": f"{destination}主城区", "note": "必尝本地招牌菜"}
    ]

    stay_cities = [n["name"] for n in via_nodes if n.get("role") in {"via", "destination"}]
    hotels = [
        {
            "name": f"{city}核心商圈酒店",
            "place": f"{city}市中心",
            "note": "停车方便，适合自驾落脚",
        }
        for city in (stay_cities[:3] or [destination])
    ]
    tips = [
        f"全程约 {distance_label}，建议每驾驶 2 小时进服务区休息 15 分钟。",
        f"节奏：{ {'relaxed':'轻松慢游','balanced':'经典均衡','hardcore':'特种兵'}[pace] } · 主题：{theme_label}。",
        f"{destination}近期天气：{weather.get('summary','多云')}，早晚温差注意备衣。",
        "热门景区与老字号餐厅建议提前预约，错峰出行体验更佳。",
    ]
    budget = _build_budget(
        distance_km,
        days,
        budget_level,
        highway,
        budget_min=budget_min,
        budget_max=budget_max,
        pax=pax,
        energy_type=energy_type,
    )
    checklist = _build_checklist(distance_km, days, weather, destination)
    fit_verdict = _build_fit_verdict(distance_km, days, transit_days, pace, theme_label, weather)
    # 挂真实日历：每天有日期与星期；撞上法定节假日时给出提示
    try:
        trip_start = date.fromisoformat(str(start_date or "").strip())
    except ValueError:
        trip_start = date.today() + timedelta(days=1)
    for d_plan in days_plan:
        day_no = int(d_plan.get("day") or 1)
        day_date = trip_start + timedelta(days=day_no - 1)
        d_plan["date"] = day_date.isoformat()
        d_plan["weekday"] = weekday_cn(day_date)
    holiday_hit = holiday_note(trip_start, days)
    if holiday_hit:
        tips.append(holiday_hit)

    pitfalls = _build_pitfalls(
        origin,
        destination,
        distance_km,
        transit_days,
        weather,
        has_county_scheduled or bool(county_sights),
        days_plan=days_plan,
    )
    _annotate_rail_items(days_plan, foods, hotels, destination)
    city_vibes = {c: _city_vibe(c) for c in dict.fromkeys(via_names + [destination])}

    trip = {
        "title": f"{origin} → {destination} {days} 日自驾路书",
        "origin": origin,
        "destination": destination,
        "days": days,
        "start_date": trip_start.isoformat(),
        "date_label": f"{trip_start.month}月{trip_start.day}日出发",
        "holiday_note": holiday_hit or "",
        "distance": distance_label,
        "drive_hours": duration_label,
        "distance_km": round(distance_km, 1),
        "weather": weather.get("summary") or "适宜出行",
        "via_cities": via_names,
        "via_nodes": via_nodes,
        "city_vibes": city_vibes,
        "fit_verdict": fit_verdict,
        "pitfalls": pitfalls,
        "prefs": {
            "pace": pace,
            "theme": theme,
            "budget_level": budget_level,
            "highway": highway,
            "budget_min": budget["budget_min"],
            "budget_max": budget["budget_max"],
            "pax": budget["pax"],
            "energy_type": budget["energy_type"],
            "travel_mode": "hsr_rental" if travel_mode == "hsr_rental" else "drive",
        },
        "highlight": (
            f"跨越 {distance_label}，"
            + (f"途经 {' · '.join(via_names[1:-1])}，" if len(via_names) > 2 else "")
            + f"按「{theme_label}」节奏串联地标与烟火美食。"
        ),
        "days_plan": days_plan,
        "foods": foods,
        "hotels": hotels,
        "tips": tips,
        "budget": budget,
        "checklist": checklist,
        "sight_pool": sight_pool,
        "food_pool": food_pool,
        "city_pools": city_pools,
        "map_image": amap.get("map_image") or "",
        "origin_location": amap.get("origin_location") or "",
        "destination_location": amap.get("destination_location") or "",
        "polyline": polyline,
        "weather_chart": weather,
        "palette": amap.get("palette"),
        "hero_image": amap.get("hero_image") or "",
        "transit_days": transit_days,
        "explore_days": explore_days,
    }
    attach_local_transit(trip)
    return trip


# 有地铁的城市：市区游玩日建议「车停酒店，地铁/打车串点」
METRO_CITIES = {
    "北京", "上海", "广州", "深圳", "成都", "重庆", "杭州", "西安", "南京", "武汉",
    "天津", "苏州", "郑州", "长沙", "昆明", "沈阳", "青岛", "大连", "厦门", "合肥",
    "福州", "南宁", "贵阳", "南昌", "济南", "哈尔滨", "长春", "石家庄", "太原", "兰州",
    "乌鲁木齐", "宁波", "无锡", "东莞", "佛山", "洛阳", "徐州", "温州", "呼和浩特",
}


def attach_local_transit(trip: dict[str, Any]) -> None:
    """给每天写 local_transit：只做当天「最后一公里」备注，不改变自驾主线。"""
    hsr = trip.get("hsr") if isinstance(trip.get("hsr"), dict) else None
    days_plan = trip.get("days_plan") or []
    last = len(days_plan)
    for d in days_plan:
        city = re.sub(r"[市省区县州]$", "", str(d.get("stay_city") or "")) or ""
        metro = city in METRO_CITIES
        notes: list[dict[str, str]] = []
        if hsr and d.get("day") == 1:
            notes.append({
                "mode": "rail",
                "text": f"高铁到 {hsr.get('to_station') or city}，出站在停车场/租车点取车",
            })
            if metro:
                notes.append({
                    "mode": "metro",
                    "text": "不想当天开车：地铁/打车到酒店，次日再取车",
                })
        elif d.get("kind") in ("explore",) and metro:
            notes.append({
                "mode": "metro",
                "text": f"{city}市区：车停酒店，地铁串景点，停车难、早晚高峰拥堵",
            })
            notes.append({
                "mode": "taxi",
                "text": "晚饭/夜景回程打车更省心，免找车位、可小酌",
            })
        elif d.get("kind") == "county":
            notes.append({
                "mode": "drive",
                "text": "郊县景点分散、公交少，这天自驾最划算",
            })
        if d.get("day") == last and hsr and last > 1:
            notes.append({
                "mode": "rail",
                "text": "返程：提前 1 小时到站还车，留出安检与检票时间",
            })
        d["local_transit"] = notes


def _synthesize_itinerary(
    origin: str,
    destination: str,
    days: int,
    amap: dict[str, Any],
    tavily_text: str,
    progress: ProgressCb,
) -> dict[str, Any]:
    progress("正在整理成可交付行程单…")
    weather = amap.get("weather") or {}
    system = (
        "你是资深旅行产品经理兼行程设计师。"
        "根据给定的高德路线事实与网络攻略，输出一份可交付的自驾行程 JSON。"
        "只输出 JSON，不要 Markdown 代码块以外的解释。"
        "严禁输出原始工具 JSON；所有字段使用面向用户的中文。"
        "JSON 结构固定为："
        "{"
        '"title":"路线标题",'
        '"origin":"出发地",'
        '"destination":"目的地",'
        '"days":天数,'
        '"distance":"总里程文案",'
        '"drive_hours":"预计驾驶时长文案",'
        '"weather":"天气摘要",'
        '"via_cities":["途经城市"],'
        '"highlight":"一句话亮点",'
        '"days_plan":[{"day":1,"title":"当天主题","summary":"当天概述",'
        '"items":[{"time":"09:00","type":"drive|sight|food|hotel|tip",'
        '"title":"短标题","detail":"说明","place":"地点"}]}],'
        '"foods":[{"name":"美食","place":"城市或区域","note":"推荐理由"}],'
        '"hotels":[{"name":"住宿建议","place":"城市","note":"理由"}],'
        '"tips":["实用提示"]'
        "}"
        f"天数必须正好 {days} 天；每天 2~3 条安排即可，文字简练；"
        "里程与驾驶时长优先采用高德给出的事实。"
    )
    user = json.dumps(
        {
            "origin": origin,
            "destination": destination,
            "days": days,
            "amap_distance": amap.get("distance"),
            "amap_duration": amap.get("duration"),
            "amap_weather_summary": weather.get("summary"),
            "amap_route_excerpt": amap.get("route_raw", "")[:600],
            "tavily_guide": (tavily_text or "")[:1200],
        },
        ensure_ascii=False,
    )
    data = _extract_json(_chat(system, user, temperature=0.2))
    data["origin"] = data.get("origin") or origin
    data["destination"] = data.get("destination") or destination
    data["days"] = days
    data["distance"] = data.get("distance") or amap.get("distance") or "—"
    data["drive_hours"] = data.get("drive_hours") or amap.get("duration") or "—"
    data["weather"] = data.get("weather") or weather.get("summary") or "天气信息暂缺"
    data["map_image"] = amap.get("map_image") or ""
    data["origin_location"] = amap.get("origin_location") or ""
    data["destination_location"] = amap.get("destination_location") or ""
    data["polyline"] = amap.get("polyline") or []
    data["weather_chart"] = weather
    if amap.get("palette"):
        data["palette"] = amap["palette"]
    if amap.get("hero_image"):
        data["hero_image"] = amap["hero_image"]
    data.setdefault("title", f"{origin} → {destination} {days} 日自驾")
    data.setdefault("via_cities", [])
    data.setdefault("highlight", "")
    data.setdefault("days_plan", [])
    data.setdefault("foods", [])
    data.setdefault("hotels", [])
    data.setdefault("tips", [])
    return data


def _amap_photo_url(text: str) -> str | None:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    pois = []
    if isinstance(data, dict):
        pois = data.get("pois") or data.get("return") or []
    if not isinstance(pois, list):
        return None
    for poi in pois:
        if not isinstance(poi, dict):
            continue
        photos = poi.get("photos")
        if isinstance(photos, dict) and photos.get("url"):
            url = photos["url"]
            if isinstance(url, list):
                url = url[0] if url else ""
            normalized = _normalize_photo_url(str(url) if url else "")
            if normalized:
                return normalized
        if isinstance(photos, list) and photos:
            first = photos[0]
            if isinstance(first, dict) and first.get("url"):
                normalized = _normalize_photo_url(str(first["url"]))
                if normalized:
                    return normalized
            if isinstance(first, str):
                normalized = _normalize_photo_url(first)
                if normalized:
                    return normalized
    found = _first_image_url(text)
    return _normalize_photo_url(found) or None


def _hsl_hex(h: float, s: float, l: float) -> str:
    r, g, b = colorsys.hls_to_rgb(h % 1.0, max(0.0, min(1.0, l)), max(0.0, min(1.0, s)))
    return f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"


def _seed_palette(city: str) -> dict[str, str]:
    """按城市名哈希生成稳定种子色板，不依赖外网图片。"""
    text = (city or "路书").strip() or "路书"
    hash_v = 2166136261
    for ch in text:
        hash_v ^= ord(ch)
        hash_v = (hash_v * 16777619) & 0xFFFFFFFF
    h = (hash_v % 360) / 360.0
    # 用 HLS 中等饱和度推一个种子 RGB，再走统一 MD3 派生
    r, g, b = colorsys.hls_to_rgb(h, 0.42, 0.62)
    return build_md3_palette((int(r * 255), int(g * 255), int(b * 255)))


def build_md3_palette(seed_rgb: tuple[int, int, int] | None = None) -> dict[str, Any]:
    """根据种子色派生 MD3 浅色与深色两套角色色板。"""
    if not seed_rgb:
        h, s = 0.56, 0.72  # 默认蓝青
    else:
        r, g, b = [x / 255.0 for x in seed_rgb]
        h, _l, s = colorsys.rgb_to_hls(r, g, b)
        s = max(0.45, min(0.78, s))

    sec_h = (h + 0.04) % 1.0
    ter_h = (h + 0.14) % 1.0
    light = {
        "primary": _hsl_hex(h, s, 0.34),
        "onPrimary": "#ffffff",
        "primaryContainer": _hsl_hex(h, s * 0.75, 0.91),
        "onPrimaryContainer": _hsl_hex(h, s, 0.14),
        "secondary": _hsl_hex(sec_h, s * 0.45, 0.38),
        "secondaryContainer": _hsl_hex(sec_h, s * 0.45, 0.92),
        "onSecondaryContainer": _hsl_hex(sec_h, s * 0.55, 0.16),
        "tertiary": _hsl_hex(ter_h, s * 0.55, 0.38),
        "tertiaryContainer": _hsl_hex(ter_h, s * 0.55, 0.92),
        "surface": _hsl_hex(h, 0.22, 0.985),
        "surfaceDim": _hsl_hex(h, 0.20, 0.94),
        "surfaceContainer": _hsl_hex(h, 0.24, 0.96),
        "surfaceContainerHigh": _hsl_hex(h, 0.24, 0.93),
        "onSurface": _hsl_hex(h, 0.25, 0.11),
        "onSurfaceVariant": _hsl_hex(h, 0.14, 0.36),
        "outline": _hsl_hex(h, 0.14, 0.58),
        "outlineVariant": _hsl_hex(h, 0.18, 0.82),
        "heroStart": _hsl_hex(h, s * 0.75, 0.14),
        "heroMid": _hsl_hex(h, s * 0.80, 0.22),
        "heroEnd": _hsl_hex(ter_h, s * 0.70, 0.26),
    }
    # 暗色：主色偏亮、表面带色相、容器比表面略抬升（MD3 dark roles）
    dark = {
        "primary": _hsl_hex(h, max(0.35, s * 0.72), 0.78),
        "onPrimary": _hsl_hex(h, s, 0.14),
        "primaryContainer": _hsl_hex(h, s * 0.55, 0.26),
        "onPrimaryContainer": _hsl_hex(h, s * 0.55, 0.90),
        "secondary": _hsl_hex(sec_h, max(0.22, s * 0.35), 0.78),
        "secondaryContainer": _hsl_hex(sec_h, s * 0.28, 0.24),
        "onSecondaryContainer": _hsl_hex(sec_h, s * 0.30, 0.90),
        "tertiary": _hsl_hex(ter_h, max(0.28, s * 0.42), 0.80),
        "tertiaryContainer": _hsl_hex(ter_h, s * 0.35, 0.26),
        "surface": _hsl_hex(h, 0.14, 0.10),
        "surfaceDim": _hsl_hex(h, 0.14, 0.07),
        "surfaceContainer": _hsl_hex(h, 0.12, 0.14),
        "surfaceContainerHigh": _hsl_hex(h, 0.12, 0.18),
        "onSurface": _hsl_hex(h, 0.08, 0.92),
        "onSurfaceVariant": _hsl_hex(h, 0.10, 0.74),
        "outline": _hsl_hex(h, 0.12, 0.55),
        "outlineVariant": _hsl_hex(h, 0.12, 0.28),
        "heroStart": _hsl_hex(h, s * 0.55, 0.08),
        "heroMid": _hsl_hex(h, s * 0.60, 0.14),
        "heroEnd": _hsl_hex(ter_h, s * 0.50, 0.18),
    }
    return {
        "seed": _hsl_hex(h, s, 0.45),
        "light": light,
        "dark": dark,
        **light,
    }


async def extract_palette_from_urls(urls: list[str]) -> dict[str, str]:
    """从第一张可用配图取主色，生成 MD3 色板。

    使用 trust_env=False，避免本机 HTTP(S)_PROXY 把高德图片请求挂死；
    超时压到 2.5s，失败即回退种子色板。
    """
    for url in urls:
        if not url:
            continue
        try:
            async with httpx.AsyncClient(
                timeout=2.5,
                follow_redirects=True,
                trust_env=False,
            ) as client:
                resp = await client.get(url)
                if resp.status_code != 200 or not resp.content:
                    continue
            img = Image.open(BytesIO(resp.content)).convert("RGB").resize((48, 48))
            best_score = -1.0
            best_rgb: tuple[int, int, int] | None = None
            for r, g, b in img.getdata():
                _h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
                if l < 0.15 or l > 0.85 or s < 0.18:
                    continue
                score = s * (1.0 - abs(l - 0.5))
                if score > best_score:
                    best_score = score
                    best_rgb = (r, g, b)
            if best_rgb:
                return build_md3_palette(best_rgb)
        except Exception:
            continue
    return build_md3_palette(None)


_TONE_CACHE: dict[str, dict[str, str] | None] = {}


async def _image_tone(client: httpx.AsyncClient, url: str) -> dict[str, str] | None:
    if url in _TONE_CACHE:
        return _TONE_CACHE[url]
    tone: dict[str, str] | None = None
    try:
        resp = await client.get(url)
        if resp.status_code == 200 and resp.content:
            img = Image.open(BytesIO(resp.content)).convert("RGB").resize((32, 32))
            weight_sum = 0.0
            hx = hy = sat = lum = 0.0
            for r, g, b in img.getdata():
                h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
                w = 0.15 + s * (1.0 - abs(l - 0.5))
                hx += math.cos(h * math.tau) * w
                hy += math.sin(h * math.tau) * w
                sat += s * w
                lum += l * w
                weight_sum += w
            h = (math.atan2(hy, hx) / math.tau) % 1.0
            s = sat / weight_sum
            inv_h = (h + 0.5) % 1.0
            inv_s = max(0.35, min(0.7, s * 1.2))
            tone = {
                "dominant": _hsl_hex(h, s, lum / weight_sum),
                "inverse": _hsl_hex(inv_h, inv_s, 0.30),
                "inverseDeep": _hsl_hex(inv_h, inv_s * 0.8, 0.12),
            }
    except Exception:
        tone = None
    _TONE_CACHE[url] = tone
    return tone


async def image_tones(urls: list[str]) -> dict[str, dict[str, str]]:
    """取每张配图主色并给出补色（反色）蒙层，用于天气底罩。"""
    targets = [u for u in dict.fromkeys(urls) if u and u.startswith("http")][:40]
    async with httpx.AsyncClient(timeout=3.0, follow_redirects=True, trust_env=False) as client:
        results = await asyncio.gather(*(_image_tone(client, u) for u in targets))
    return {u: t for u, t in zip(targets, results) if t}


async def enrich_photos(
    trip: dict[str, Any],
    progress: ProgressCb | None = None,
) -> dict[str, Any]:
    """为景点与美食补图（优先高德 POI 实拍，最多各 4 张）。"""
    progress = progress or _noop_progress
    if not has_server("amap-maps"):
        return trip

    sights: list[tuple[int, int, str, str]] = []  # day_idx, item_idx, keywords, city
    for di, day in enumerate(trip.get("days_plan") or []):
        for ii, item in enumerate(day.get("items") or []):
            if item.get("type") == "sight" and len(sights) < 2:
                keywords = (item.get("title") or item.get("place") or "").strip()
                city = (item.get("place") or trip.get("destination") or "").strip()
                if keywords:
                    sights.append((di, ii, keywords, city))

    foods = trip.get("foods") or []
    food_jobs: list[tuple[int, str, str]] = []
    for fi, food in enumerate(foods[:3]):
        name = (food.get("name") or "").strip()
        city = (food.get("place") or trip.get("destination") or "").strip()
        if name:
            food_jobs.append((fi, name, city))

    if not sights and not food_jobs:
        return trip

    progress("正在为景点与美食配图…")

    async def one_amap_image(session, keywords: str, city: str) -> str | None:
        try:
            text = await session.call_tool(
                "maps_text_search",
                {"keywords": keywords, "city": city or trip.get("destination") or ""},
            )
            return _amap_photo_url(text)
        except Exception:
            return None

    async with open_server_session("amap-maps") as amap:
        tasks = [one_amap_image(amap, kw, city) for _, _, kw, city in sights]
        tasks += [one_amap_image(amap, name, city) for _, name, city in food_jobs]
        results = await asyncio.gather(*tasks)

    for idx, (di, ii, _, _) in enumerate(sights):
        url = results[idx]
        if url:
            trip["days_plan"][di]["items"][ii]["image"] = url

    offset = len(sights)
    for j, (fi, _, _) in enumerate(food_jobs):
        url = results[offset + j]
        if url and fi < len(trip["foods"]):
            trip["foods"][fi]["image"] = url

    photo_urls = [u for u in results if u]
    if not trip.get("palette"):
        trip["palette"] = await extract_palette_from_urls(photo_urls)
    if not trip.get("hero_image") and photo_urls:
        trip["hero_image"] = photo_urls[0]
    return trip


def _stamp_brief(trip: dict[str, Any], note: str) -> dict[str, Any]:
    if not note:
        return trip
    highlight = str(trip.get("highlight") or "")
    if not highlight.startswith(note):
        trip["highlight"] = note + highlight
    tips = [str(item) for item in (trip.get("tips") or [])]
    if note not in tips:
        trip["tips"] = [note, *tips]
    return trip


async def plan_trip_async(
    query: str = "",
    origin: str = "",
    destination: str = "",
    days: int | None = None,
    pace: str = "balanced",
    theme: str = "landmark",
    budget_level: str = "comfort",
    highway: str = "express",
    budget_min: int | None = None,
    budget_max: int | None = None,
    pax: int = 2,
    energy_type: str = "oil",
    travel_mode: str = "drive",
    start_date: str = "",
    only_region: str = "",
    progress: ProgressCb | None = None,
    stage: StageCb | None = None,
    with_photos: bool = True,
) -> dict[str, Any]:
    """完整规划流程；可通过 stage 回调边算边推送。"""
    progress = progress or _noop_progress
    progress("正在理解出行需求…")
    params = parse_trip_request(
        query=query,
        origin=origin,
        destination=destination,
        days=days,
        pace=pace,
        theme=theme,
        budget_level=budget_level,
        highway=highway,
        budget_min=budget_min,
        budget_max=budget_max,
        pax=pax,
        energy_type=energy_type,
        travel_mode=travel_mode,
    )
    origin = params["origin"]
    destination = params["destination"]
    days = params["days"]
    region = str(only_region or "").strip()
    if region.endswith("省"):
        region = region[:-1]
    if region not in PROVINCE_CITIES:
        region = ""
    brief_note = f"游玩只安排在{region}，其余路线和景点按你的确认来排。" if region else ""
    exclude_via = None
    if region:
        keep = PROVINCE_CITIES[region] | {origin, destination}
        exclude_via = {name for name in CITY_COORDS if name not in keep}
    pace = params["pace"]
    theme = params["theme"]
    budget_level = params["budget_level"]
    highway = params["highway"]
    budget_min = params["budget_min"]
    budget_max = params["budget_max"]
    pax = params["pax"]
    energy_type = params["energy_type"]
    travel_mode = params.get("travel_mode") or "drive"
    try:
        trip_start = date.fromisoformat(str(start_date or "").strip())
    except ValueError:
        trip_start = date.today() + timedelta(days=1)
    if not origin or not destination:
        raise RuntimeError("请提供出发地和目的地，例如：规划从北京到成都的7天自驾游")

    await _emit(
        stage,
        "skeleton",
        {
            "title": f"{origin} → {destination} {days} 日自驾",
            "origin": origin,
            "destination": destination,
            "days": days,
            "distance": "计算中…",
            "drive_hours": "计算中…",
            "weather": "查询中…",
            "highlight": brief_note or "正在为你规划路线与攻略…",
            "prefs": {
                "pace": pace,
                "theme": theme,
                "budget_level": budget_level,
                "highway": highway,
                "budget_min": budget_min,
                "budget_max": budget_max,
                "pax": pax,
                "energy_type": energy_type,
                "travel_mode": travel_mode,
            },
        },
    )

    cache_key = (
        origin,
        destination,
        days,
        pace,
        theme,
        budget_level,
        highway,
        budget_min,
        budget_max,
        pax,
        energy_type,
        travel_mode,
        trip_start.isoformat(),
        region,
    )
    cached = _TRIP_CACHE.get(cache_key)
    if cached:
        progress("已命中路书缓存，秒级加载…")
        if cached.get("palette"):
            await _emit(
                stage,
                "palette",
                {"palette": cached["palette"], "hero_image": cached.get("hero_image") or ""},
            )
        await _emit(
            stage,
            "geo",
            {
                "origin": origin,
                "destination": destination,
                "origin_location": cached.get("origin_location"),
                "destination_location": cached.get("destination_location"),
            },
        )
        await _emit(
            stage,
            "route",
            {
                "distance": cached.get("distance"),
                "drive_hours": cached.get("drive_hours"),
                "origin": origin,
                "destination": destination,
                "origin_location": cached.get("origin_location"),
                "destination_location": cached.get("destination_location"),
                "polyline": cached.get("polyline") or [],
                "via_nodes": cached.get("via_nodes") or [],
                "via_cities": cached.get("via_cities") or [],
            },
        )
        if cached.get("weather_chart"):
            await _emit(stage, "weather", cached["weather_chart"])
        final = await _maybe_attach_hsr(
            cached, travel_mode, origin, destination, days, pax, budget_level, progress,
            travel_date=trip_start.isoformat(),
        )
        await _emit(stage, "itinerary", final)
        await _emit(stage, "done", {"ok": True, "cached": True})
        return final

    amap = await _gather_amap_staged(origin, destination, progress, stage)

    # 先用高德真实路线 + 途经切分 + POI 候选池在 ~3 秒内直接推出完整路书
    fast_trip = _build_fast_itinerary(
        origin,
        destination,
        days,
        amap,
        pace=pace,
        theme=theme,
        budget_level=budget_level,
        highway=highway,
        budget_min=budget_min,
        budget_max=budget_max,
        pax=pax,
        energy_type=energy_type,
        start_date=trip_start.isoformat(),
        travel_mode=travel_mode,
        exclude_via=exclude_via,
    )
    _stamp_brief(fast_trip, brief_note)
    await _emit(
        stage,
        "route",
        {
            "distance": fast_trip.get("distance"),
            "drive_hours": fast_trip.get("drive_hours"),
            "origin": origin,
            "destination": destination,
            "origin_location": fast_trip.get("origin_location"),
            "destination_location": fast_trip.get("destination_location"),
            "polyline": fast_trip.get("polyline") or [],
            "via_nodes": fast_trip.get("via_nodes") or [],
            "via_cities": fast_trip.get("via_cities") or [],
        },
    )
    await _emit(stage, "itinerary", fast_trip)

    # 可选：若开启 LLM 精修且在 7 秒内返回，则无感升级文案；超时直接使用快速路书
    trip = fast_trip
    if os.getenv("ROADBOOK_LLM_REFINE", "0") == "1":
        try:
            refined = await asyncio.wait_for(
                asyncio.to_thread(
                    _synthesize_itinerary, origin, destination, days, amap, "", progress
                ),
                timeout=7.0,
            )
            if with_photos:
                refined = await enrich_photos(refined, progress=progress)
            trip = _stamp_brief(refined, brief_note)
            await _emit(stage, "itinerary", trip)
        except Exception:
            pass

    if with_photos:
        try:
            trip = await fill_pool_list_images(trip)
        except Exception:
            pass
    _TRIP_CACHE[cache_key] = trip
    trip = await _maybe_attach_hsr(
        trip, travel_mode, origin, destination, days, pax, budget_level, progress,
        travel_date=trip_start.isoformat(),
    )
    _TRIP_CACHE[cache_key] = trip
    await _emit(stage, "itinerary", trip)
    await _emit(stage, "done", {"ok": True})
    return trip


async def _maybe_attach_hsr(
    trip: dict[str, Any],
    travel_mode: str,
    origin: str,
    destination: str,
    days: int,
    pax: int,
    budget_level: str,
    progress: ProgressCb,
    travel_date: str = "",
) -> dict[str, Any]:
    if travel_mode != "hsr_rental":
        return trip
    from rail_hsr import attach_hsr_rental_to_trip

    progress("查询高铁班次 · 到站租车方案…")
    return await attach_hsr_rental_to_trip(
        trip,
        origin,
        destination,
        days=days,
        pax=pax,
        budget_level=budget_level,
        travel_date=travel_date or None,
    )


def _extract_known_cities(text: str) -> list[str]:
    """从一句话里按出现顺序提取已知城市/宝藏县名。"""
    found: list[tuple[int, str]] = []
    for name in sorted(CITY_COORDS.keys(), key=len, reverse=True):
        idx = text.find(name)
        if idx >= 0:
            found.append((idx, name))
    found.sort(key=lambda x: x[0])
    out: list[str] = []
    for _, n in found:
        if n not in out:
            out.append(n)
    return out


def _carry_hsr(new_trip: dict[str, Any], old_trip: dict[str, Any]) -> None:
    """重排/微调后保留高铁票，并按新天数刷新租车；路线折线以新路书为准。"""
    hsr = old_trip.get("hsr")
    prefs = new_trip.get("prefs") or {}
    if not isinstance(hsr, dict) or prefs.get("travel_mode") != "hsr_rental":
        return
    import copy

    hsr = copy.deepcopy(hsr)
    days = max(1, int(new_trip.get("days") or 7))
    daily = int(hsr.get("rental_daily") or 260)
    hsr["rental_days"] = days
    hsr["rental_total"] = days * daily
    local_km = int(round(float(new_trip.get("distance_km") or 0))) or max(80, days * 55)
    hsr["local_drive_km"] = local_km
    hsr["local_drive_hint"] = f"路书驾车约 {local_km}km"
    hsr["route_label"] = new_trip.get("distance") or hsr.get("route_label")
    new_trip["hsr"] = hsr
    budget = new_trip.setdefault("budget", {})
    pax = int(hsr.get("pax") or budget.get("pax") or 2)
    per = float(hsr.get("reference_second_class") or 0)
    if per:
        budget["hsr_tickets"] = int(round(per * pax))
        hsr["ticket_total"] = budget["hsr_tickets"]
    budget["car_rental"] = hsr["rental_total"]
    budget["local_drive_km"] = int(local_km)
    top = (hsr.get("trains") or [{}])[0]
    via = " → ".join(new_trip.get("via_cities") or [])
    if top.get("train_no"):
        label = top.get("via_label") or ""
        extra = f"，{label}" if label else ""
        note = str(hsr.get("via_note") or "").strip()
        new_trip["highlight"] = (
            f"高铁仍为 {top['train_no']} {top.get('from_station')}→{top.get('to_station')}{extra}；"
            f"途经 {via}。"
            + (note or f"驾车 {new_trip.get('distance', '—')}。")
        )
    attach_local_transit(new_trip)


async def apply_via_reorder_async(current_trip: dict[str, Any], via_cities: list[str]) -> dict[str, Any]:
    """按用户拖拽顺序重排途经城并重建 fast 路书（保留 prefs / chat_log）。"""
    origin = str(current_trip.get("origin") or "北京").strip()
    destination = str(current_trip.get("destination") or "成都").strip()
    days = int(current_trip.get("days") or 7)
    prefs = dict(current_trip.get("prefs") or {})
    pace = str(prefs.get("pace") or "balanced")
    theme = str(prefs.get("theme") or "landmark")
    budget_level = str(prefs.get("budget_level") or "comfort")
    highway = str(prefs.get("highway") or "express")
    cur_budget = current_trip.get("budget") or {}
    budget_min = prefs.get("budget_min") or cur_budget.get("budget_min")
    budget_max = prefs.get("budget_max") or cur_budget.get("budget_max")
    pax = int(prefs.get("pax") or cur_budget.get("pax") or 2)
    energy_type = str(prefs.get("energy_type") or cur_budget.get("energy_type") or "oil")

    def _clean(c: str) -> str:
        return re.sub(r"[市省区县]$", "", str(c or "").strip()) or str(c or "").strip()

    via_clean = [_clean(c) for c in via_cities if c]
    o, d = _clean(origin), _clean(destination)
    if not via_clean or _clean(via_clean[0]) != o:
        via_clean = [o] + [c for c in via_clean if _clean(c) not in {o, d}]
    if _clean(via_clean[-1]) != d:
        via_clean = [c for c in via_clean if _clean(c) != d] + [d]

    custom_via = [c for c in via_clean if _clean(c) not in {o, d}]
    old_mid = [c for c in (current_trip.get("via_cities") or []) if _clean(c) not in {o, d}]
    if custom_via == old_mid:
        return {
            "trip": current_trip,
            "reply": "途经顺序未变化",
            "changes": [],
            "focus_day": None,
        }

    amap_stub = {
        "distance": current_trip.get("distance") or f"{current_trip.get('distance_km') or 0:.0f} 公里",
        "duration": current_trip.get("drive_hours") or "",
        "polyline": current_trip.get("polyline") or [],
        "origin_location": current_trip.get("origin_location") or _cached_coord(origin) or "",
        "destination_location": current_trip.get("destination_location") or _cached_coord(destination) or "",
        "weather": current_trip.get("weather_chart") or {},
        "sight_pool": current_trip.get("sight_pool") or [],
        "food_pool": current_trip.get("food_pool") or [],
        "palette": current_trip.get("palette"),
        "hero_image": current_trip.get("hero_image") or "",
        "map_image": current_trip.get("map_image") or "",
    }
    if len(custom_via) + 2 > days:
        days = min(14, len(custom_via) + 2)
    leg_km = await _reroute_stub(amap_stub, origin, destination, custom_via)

    new_trip = _build_fast_itinerary(
        origin,
        destination,
        days,
        amap_stub,
        pace=pace,
        theme=theme,
        budget_level=budget_level,
        highway=highway,
        custom_via=custom_via,
        exclude_via=set(),
        budget_min=budget_min,
        budget_max=budget_max,
        pax=pax,
        energy_type=energy_type,
        fill_via=False,
        leg_km=leg_km,
        start_date=current_trip.get("start_date") or "",
        travel_mode=str(prefs.get("travel_mode") or "drive"),
    )
    new_trip["prefs"] = {**prefs, "via_locked": True}
    new_trip["chat_log"] = list(current_trip.get("chat_log") or [])
    _carry_hsr(new_trip, current_trip)
    from rail_hsr import refresh_hsr_for_vias

    await refresh_hsr_for_vias(new_trip)

    label = " → ".join(new_trip.get("via_cities") or [])
    hint = _long_drive_hint(new_trip, pace)
    consequence = _edit_consequence_line(current_trip, new_trip)
    _reuse_list_images(new_trip, current_trip)
    return {
        "trip": new_trip,
        "reply": (
            f"已按新顺序重排途经：{label}，全程 {new_trip.get('distance', '—')}。"
            + (f"{hint}。" if hint else "")
            + f"{consequence}。"
        ),
        "changes": [f"途经顺序 → {label}"],
        "focus_day": None,
    }


async def apply_chat_edit_async(
    current_trip: dict[str, Any],
    message: str,
) -> dict[str, Any]:
    """无状态对话微调：接收当前路书 JSON + 用户一句话，0 数据库/0 长历史，返回新路书与变更回执。"""
    msg = (message or "").strip()
    if not msg:
        raise RuntimeError("请输入你想调整的内容，例如：中间加个西安、玩8天、节奏调轻松")

    origin = str(current_trip.get("origin") or "北京").strip()
    destination = str(current_trip.get("destination") or "成都").strip()
    days = int(current_trip.get("days") or 7)
    prefs = dict(current_trip.get("prefs") or {})
    pace = str(prefs.get("pace") or "balanced")
    theme = str(prefs.get("theme") or "landmark")
    budget_level = str(prefs.get("budget_level") or "comfort")
    highway = str(prefs.get("highway") or "express")
    cur_budget = current_trip.get("budget") or {}
    budget_min = prefs.get("budget_min") or cur_budget.get("budget_min")
    budget_max = prefs.get("budget_max") or cur_budget.get("budget_max")
    pax = int(prefs.get("pax") or cur_budget.get("pax") or 2)
    energy_type = str(prefs.get("energy_type") or cur_budget.get("energy_type") or "oil")

    current_via = [
        c
        for c in (current_trip.get("via_cities") or [])
        if c and c not in {origin, destination}
    ]
    custom_via = list(current_via)
    added_via: list[str] = []
    removed_via: list[str] = []
    exclude_via: set[str] = set()
    changes: list[str] = []
    focus_day: int | None = None
    need_full_replan = False

    # 1) 天数修改（如 "玩8天" / "改成5天" / "延长到9天"）
    m_days = re.search(r"(?:改成|变成|调成|延长到|缩短到|玩|共|一共)?\s*(\d{1,2})\s*[天日]", msg)
    if m_days and not re.search(r"第\s*\d+\s*[天日]", msg[: m_days.start() + 3]):
        new_days = max(1, min(14, int(m_days.group(1))))
        if new_days != days:
            changes.append(f"天数 {days}天 → {new_days}天")
            days = new_days

    # 2) 起点 / 终点修改
    m_orig = re.search(r"(?:从|起点(?:改成|换成|设为)?|出发地(?:改成|换成)?)\s*([\u4e00-\u9fa5]{2,5}?)(?:出发|走|开始|$|[，,。 ])", msg)
    if m_orig:
        cand = re.sub(r"[市省区县]$", "", m_orig.group(1))
        if cand in CITY_COORDS and cand != origin:
            changes.append(f"出发地 {origin} → {cand}")
            origin = cand
            custom_via = []
            need_full_replan = True

    m_dest = re.search(r"(?:终点(?:改成|换成|设为)?|目的地(?:改成|换成)?|改去|换去)\s*([\u4e00-\u9fa5]{2,5}?)(?:玩|吧|$|[，,。 ])", msg)
    if m_dest:
        cand = re.sub(r"[市省区县]$", "", m_dest.group(1))
        if cand in CITY_COORDS and cand != destination:
            changes.append(f"目的地 {destination} → {cand}")
            destination = cand
            custom_via = []
            need_full_replan = True

    # 3) 替换/删除/增加途经城市（如 "把运城换成西安"、"不去汉中"、"中间加个洛阳"）
    m_swap = re.search(r"把\s*([\u4e00-\u9fa5]{2,5}?)\s*(?:换成|改成|替换为)\s*([\u4e00-\u9fa5]{2,5})", msg)
    if m_swap:
        old_c = re.sub(r"[市省区县]$", "", m_swap.group(1))
        new_c = re.sub(r"[市省区县]$", "", m_swap.group(2))
        if new_c in CITY_COORDS:
            exclude_via.add(old_c)
            if old_c in custom_via:
                custom_via = [new_c if x == old_c else x for x in custom_via]
            elif new_c not in custom_via:
                custom_via.append(new_c)
            added_via.append(new_c)
            changes.append(f"途经城 {old_c} → {new_c}")

    for m_del in re.finditer(r"(?:不去|删掉|去掉|跳过|取消|移除)\s*([\u4e00-\u9fa5]{2,6})", msg):
        target = re.sub(r"[市省区县]$", "", m_del.group(1))
        if target in CITY_COORDS and target not in {origin, destination}:
            exclude_via.add(target)
            custom_via = [x for x in custom_via if x != target]
            removed_via.append(target)
            changes.append(f"跳过途经城「{target}」")

    via_intent = re.search(r"途经|中间|顺路|加上|加个|增加|经过|绕道|去一趟|住一晚|停一下", msg)
    if via_intent:
        for c in _extract_known_cities(msg):
            if c not in {origin, destination} and c not in exclude_via and c not in custom_via:
                custom_via.append(c)
                added_via.append(c)
                changes.append(f"新增途经「{c}」")
        if (
            not added_via
            and not removed_via
            and re.search(r"(?:加个|加上|途经|中间|经过)\s*[\u4e00-\u9fa5]{2,}", msg)
        ):
            return {
                "trip": current_trip,
                "reply": "没有识别到途经城市，请用常见地名再试一次，例如西安、洛阳。",
                "changes": [],
                "focus_day": None,
            }

    # 4) 节奏 / 主题 / 预算 / 高速偏好
    if re.search(r"轻松|慢游|慢一点|太累|带老人|不赶路|悠闲", msg) and pace != "relaxed":
        pace = "relaxed"
        changes.append("节奏 → 轻松慢游")
    elif re.search(r"特种兵|紧凑|多逛|拉满|高强度", msg) and pace != "hardcore":
        pace = "hardcore"
        changes.append("节奏 → 特种兵")
    elif re.search(r"均衡|标准|正常节奏", msg) and pace != "balanced":
        pace = "balanced"
        changes.append("节奏 → 经典均衡")

    if re.search(r"美食|吃货|火锅|小吃|苍蝇馆|夜宵", msg) and theme != "food":
        theme = "food"
        changes.append("主题 → 烟火美食")
    elif re.search(r"亲子|带娃|孩子|小朋友|乐园", msg) and theme != "family":
        theme = "family"
        changes.append("主题 → 亲子友好")
    elif re.search(r"摄影|拍照|出片|机位|古建|人文", msg) and theme != "photo":
        theme = "photo"
        changes.append("主题 → 人文摄影")
    elif re.search(r"经典|地标|必打卡", msg) and theme != "landmark":
        theme = "landmark"
        changes.append("主题 → 经典地标")

    if re.search(r"经济|穷游|省钱|便宜|平价", msg) and budget_level != "economy":
        budget_level = "economy"
        budget_min, budget_max = None, None
        changes.append("预算 → 经济省钱档（日均 ¥150~260/人·天）")
    elif re.search(r"轻奢|豪华|品质好点|住好点|高档", msg) and budget_level != "premium":
        budget_level = "premium"
        budget_min, budget_max = None, None
        changes.append("预算 → 品质度假档（日均 ¥450~780/人·天）")
    elif re.search(r"舒适|中等预算", msg) and budget_level != "comfort":
        budget_level = "comfort"
        budget_min, budget_max = None, None
        changes.append("预算 → 舒适口碑档（日均 ¥260~420/人·天）")

    # 解析具体预算区间（如 "预算2000到3500" / "人均3000以内"）
    m_b_range = re.search(r"(?:预算|人均)[^\d]{0,4}(\d{3,5})\s*(?:到|~|-|—|至)\s*(\d{3,5})", msg)
    if m_b_range:
        budget_min = int(m_b_range.group(1))
        budget_max = int(m_b_range.group(2))
        changes.append(f"预算区间 → ¥{budget_min}~¥{budget_max}/人")
    else:
        m_b_cap = re.search(r"(?:预算|人均|控制在)[^\d]{0,4}(\d{3,5})\s*(?:元|块)?(?:以内|以下|左右)?", msg)
        if m_b_cap:
            cap = int(m_b_cap.group(1))
            budget_min = max(800, round(cap * 0.65 / 100) * 100)
            budget_max = cap
            changes.append(f"预算上限 → ¥{cap}/人")

    m_pax = re.search(r"(\d)\s*(?:个人|人同车|人分摊|人出行)", msg)
    if m_pax:
        pax = max(1, min(5, int(m_pax.group(1))))
        changes.append(f"同车分摊 → {pax}人")

    if re.search(r"电车|新能源|纯电|特斯拉|蔚来|充电", msg) and energy_type != "ev":
        energy_type = "ev"
        changes.append("车型 → 纯电/新能源（按快充测算）")
    elif re.search(r"油车|燃油|加油", msg) and energy_type != "oil":
        energy_type = "oil"
        changes.append("车型 → 燃油车")

    if re.search(r"国道|省道|少走高速|风景线|不走高速", msg) and highway != "scenic":
        highway = "scenic"
        changes.append("路线 → 少走高速看风景")
    elif re.search(r"高速优先|走高速|最快", msg) and highway != "express":
        highway = "express"
        changes.append("路线 → 高速优先")

    # 5) 针对某一天的局部指令（如 "Day 5 换成三星堆" / "第6天去都江堰"）
    _cn_day = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    m_day = re.search(r"(?:day|d|第)\s*(\d{1,2}|[一二三四五六七八九十])\s*[天日]?", msg, re.I)
    day_target_kw = ""
    if m_day:
        raw_day = m_day.group(1)
        focus_day = int(raw_day) if raw_day.isdigit() else _cn_day.get(raw_day, 0)
        rest = msg[m_day.end() :]
        m_kw = re.search(r"(?:换成|改成|去|加个|安排)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12})", rest)
        if m_kw:
            day_target_kw = m_kw.group(1).strip()

    # 若一句话只写了城市名（例如直接输入 "西安" 或 "+洛阳"），默认作为新增途经城
    if not changes and not day_target_kw:
        mentioned = [c for c in _extract_known_cities(msg) if c not in {origin, destination}]
        if mentioned:
            for c in mentioned:
                if c in custom_via:
                    continue
                custom_via.append(c)
                added_via.append(c)
                changes.append(f"新增途经「{c}」")

    # 用户删过城或拖过顺序后，途经列表以用户为准，后续任何微调都不再按里程自动补城
    via_locked = bool(prefs.get("via_locked")) or bool(removed_via)
    if need_full_replan:
        via_locked = False
        new_trip = await plan_trip_async(
            query=f"从{origin}到{destination}的{days}天自驾",
            origin=origin,
            destination=destination,
            days=days,
            pace=pace,
            theme=theme,
            budget_level=budget_level,
            highway=highway,
            budget_min=budget_min,
            budget_max=budget_max,
            pax=pax,
            energy_type=energy_type,
            travel_mode=str(prefs.get("travel_mode") or "drive"),
            start_date=str(current_trip.get("start_date") or ""),
        )
    else:
        amap_stub = {
            "distance": current_trip.get("distance") or f"{current_trip.get('distance_km') or 0:.0f} 公里",
            "duration": current_trip.get("drive_hours") or "",
            "polyline": current_trip.get("polyline") or [],
            "origin_location": current_trip.get("origin_location") or _cached_coord(origin) or "",
            "destination_location": current_trip.get("destination_location") or _cached_coord(destination) or "",
            "weather": current_trip.get("weather_chart") or {},
            "sight_pool": current_trip.get("sight_pool") or [],
            "food_pool": current_trip.get("food_pool") or [],
            "palette": current_trip.get("palette"),
            "hero_image": current_trip.get("hero_image") or "",
            "map_image": current_trip.get("map_image") or "",
        }
        # 确保 custom_via 增减时天数足够容纳（至少 len(custom_via)+2 天）
        if len(custom_via) + 2 > days:
            days = min(14, len(custom_via) + 2)
            changes.append(f"为容纳途经城，自动延至 {days} 天")
        leg_km = (
            await _reroute_stub(amap_stub, origin, destination, custom_via, exclude_via)
            if via_locked
            else None
        )
        new_trip = _build_fast_itinerary(
            origin,
            destination,
            days,
            amap_stub,
            pace=pace,
            theme=theme,
            budget_level=budget_level,
            highway=highway,
            custom_via=custom_via,
            exclude_via=exclude_via,
            budget_min=budget_min,
            budget_max=budget_max,
            pax=pax,
            energy_type=energy_type,
            fill_via=not via_locked,
            leg_km=leg_km,
            start_date=str(current_trip.get("start_date") or ""),
            travel_mode=str(prefs.get("travel_mode") or "drive"),
        )

    # 若指定了某天换成某景点/宝藏县，定向替换该天锚点
    if focus_day and 1 <= focus_day <= len(new_trip.get("days_plan") or []):
        d_obj = new_trip["days_plan"][focus_day - 1]
        pool = list(new_trip.get("sight_pool") or [])
        matched_poi = None
        if day_target_kw:
            for p in pool:
                if day_target_kw in p.get("name", "") or day_target_kw in p.get("district", ""):
                    matched_poi = p
                    break
            if not matched_poi:
                matched_poi = {
                    "name": day_target_kw,
                    "address": f"{d_obj.get('stay_city') or destination}·{day_target_kw}",
                    "image": "",
                    "location": _cached_coord(day_target_kw) or _cached_coord(destination) or "",
                    "rating": "4.8",
                    "cost": "",
                    "tag": "定制打卡",
                    "district": day_target_kw if day_target_kw.endswith(("县", "市", "区")) else "",
                    "is_county": True,
                    "human_tags": ["#对话定制", "#核心必去"],
                    "stay_hours": 2.5,
                }
        elif pool:
            used_titles = {it.get("title") for it in d_obj.get("items") or []}
            matched_poi = next((p for p in pool if p.get("name") not in used_titles), pool[0])
        if matched_poi:
            new_stop = _poi_to_stop(
                matched_poi,
                "09:30",
                "sight",
                d_obj.get("stay_city") or destination,
                priority="anchor",
            )
            items = d_obj.get("items") or []
            replaced = False
            for idx, it in enumerate(items):
                if it.get("type") == "sight":
                    items[idx] = new_stop
                    replaced = True
                    break
            if not replaced:
                items.insert(0, new_stop)
            d_obj["title"] = f"{d_obj.get('stay_city') or destination}定制 · {matched_poi['name'][:10]}"
            changes.append(f"DAY {focus_day} 核心站 → {matched_poi['name']}")

    if not changes:
        changes.append("已按你的描述微调每日站点搭配")

    new_trip["prefs"] = {
        **prefs,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "pax": pax,
        "energy_type": energy_type,
        "via_locked": via_locked,
    }

    # 定位到最相关的那一天，方便前端高亮滚动
    if not focus_day and added_via:
        last_added = added_via[-1]
        for d_obj in new_trip.get("days_plan") or []:
            if d_obj.get("stay_city") == last_added or last_added in (d_obj.get("title") or ""):
                focus_day = d_obj.get("day")
                break

    summary = "；".join(changes)
    hint = _long_drive_hint(new_trip, pace) if via_locked else ""
    _carry_hsr(new_trip, current_trip)
    from rail_hsr import refresh_hsr_for_vias

    await refresh_hsr_for_vias(new_trip)
    consequence = _edit_consequence_line(current_trip, new_trip)
    _reuse_list_images(new_trip, current_trip)
    if focus_day and day_target_kw:
        swapped = any(
            c.startswith(f"DAY {focus_day} 核心站") and day_target_kw in c for c in changes
        )
        lead = (
            f"第{focus_day}天已换成{day_target_kw}。"
            if swapped
            else f"第{focus_day}天没换成{day_target_kw}。"
        )
        rest = [c for c in changes if day_target_kw not in c]
        mid = f"其余：{'；'.join(rest)}。" if rest else ""
    else:
        lead = f"已调整：{summary}。"
        mid = ""
    return {
        "trip": new_trip,
        "reply": (
            f"{lead}{mid}"
            f"全程现为 {new_trip.get('distance','—')}，"
            f"途经 {' → '.join(new_trip.get('via_cities') or [])}。"
            + (f"{hint}。" if hint else "")
            + f"{consequence}。"
        ),
        "changes": changes,
        "focus_day": focus_day,
    }


def plan_trip(
    query: str = "",
    origin: str = "",
    destination: str = "",
    days: int | None = None,
    progress: ProgressCb | None = None,
    with_photos: bool = True,
) -> dict[str, Any]:
    return asyncio.run(
        plan_trip_async(
            query=query,
            origin=origin,
            destination=destination,
            days=days,
            progress=progress,
            with_photos=with_photos,
        )
    )


if __name__ == "__main__":

    def _p(msg: str) -> None:
        print(msg)

    async def _stage(name: str, payload: dict[str, Any]) -> None:
        keys = list(payload.keys())[:6]
        print(f"[stage:{name}]", keys)

    result = asyncio.run(
        plan_trip_async(
            query="规划从北京到成都的7天自驾游",
            origin="北京",
            destination="成都",
            days=7,
            progress=_p,
            stage=_stage,
            with_photos=False,
        )
    )
    print(json.dumps({k: result.get(k) for k in ("title", "distance", "drive_hours", "weather")}, ensure_ascii=False))
