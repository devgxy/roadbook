"""需求描述防护，并把口语补成可生成的出发地、目的地、天数和范围。"""

from __future__ import annotations

import re
from datetime import date, timedelta

_MAX_LEN = 200
_ILLEGAL = re.compile(
    r"毒品|冰毒|海洛因|大麻|制毒|炸药|炸弹|枪支|买枪|军火|"
    r"色情|裸聊|招嫖|诈骗|洗钱|木马|入侵系统|儿童色情|未成年人.{0,6}色情"
)
_INJECTION = re.compile(
    r"(忽略|无视|forget).{0,12}(指令|规则|提示|prompt)|"
    r"(system\s*prompt|jailbreak|你现在是)",
    re.I,
)
_TRAVEL = re.compile(
    r"自驾|高铁|租车|行程|路书|出游|旅游|旅行|游玩|出发|抵达|途经|"
    r"景点|住宿|美食|几天|\d+\s*天|玩|周末|假期|这周|推荐|看看|只看|只有|只在"
)
_ROUTE = re.compile(r"从|到|去|至|→|—|-")
_FROM_TO = re.compile(r"从\s*([^\s，,。]{2,8}?)\s*(?:去|到|至)")
_WEEKEND = re.compile(r"这周末|这个周末|这周么|这周未")
_ONLY_REGION = re.compile(r"(?:只看|只有|只在|只去)\s*([\u4e00-\u9fff]{2,3})")

# 用来识别「只看某省」时，途经游玩不要跑出该省。出发地可以在省外。
PROVINCE_CITIES: dict[str, set[str]] = {
    "河南": {"郑州", "洛阳", "开封", "许昌", "南阳", "安阳", "新乡", "焦作", "商丘", "周口", "信阳", "驻马店"},
    "河北": {"石家庄", "保定", "张家口", "承德", "秦皇岛", "唐山", "沧州", "衡水", "邯郸"},
    "山西": {"太原", "大同", "运城", "临汾"},
    "陕西": {"西安", "咸阳", "宝鸡", "渭南", "汉中", "安康"},
    "山东": {"济南", "青岛", "泰安", "德州"},
}


def _clean_place(name: str) -> str:
    name = str(name or "").strip()
    if len(name) > 2 and name.endswith(("市", "省")):
        name = name[:-1]
    return name


def _normalize_query(query: str) -> str:
    text = " ".join(str(query or "").split())
    return (
        text.replace("这周么", "这周末")
        .replace("这周未", "这周末")
        .replace("这个周末", "这周末")
    )


def _upcoming_saturday(today: date | None = None) -> date:
    today = today or date.today()
    weekday = today.weekday()
    if weekday == 6:
        return today + timedelta(days=6)
    return today + timedelta(days=(5 - weekday) % 7)


def complete_trip_brief(
    query: str,
    origin: str = "",
    destination: str = "",
    days: int | None = None,
    start_date: str = "",
    today: date | None = None,
) -> dict[str, str | int | None]:
    """把「这周末从北京去郑州，只看河南，其他帮我推荐」补成可生成参数。"""
    text = _normalize_query(query)
    form_origin = str(origin or "").strip()
    form_destination = str(destination or "").strip()
    origin = form_origin
    destination = form_destination
    note_bits: list[str] = []
    matched = _FROM_TO.search(text)
    if matched:
        origin = _clean_place(matched.group(1))
        rest = text[matched.end() :]
        dest_m = re.match(r"\s*([^\s，,。看只玩游的]{2,8})", rest)
        if dest_m:
            destination = _clean_place(dest_m.group(1))
        if origin != form_origin or destination != form_destination:
            note_bits.append(f"从{origin}去{destination}")
    day_m = re.search(r"(\d+)\s*天", text)
    if day_m:
        days = max(1, min(14, int(day_m.group(1))))
    elif _WEEKEND.search(text):
        days = 2
        start_date = _upcoming_saturday(today).isoformat()
        note_bits.append("这周末出发、按 2 天")
    region_m = _ONLY_REGION.search(text)
    only_region = ""
    if region_m:
        name = region_m.group(1)
        if name.endswith("省"):
            name = name[:-1]
        if name in PROVINCE_CITIES:
            only_region = name
            note_bits.append(f"游玩只安排在{name}")
    if "推荐" in text:
        note_bits.append("其余路线和景点由路书推荐")
    note = ""
    if note_bits:
        note = "已按你的话补全：" + "，".join(note_bits) + "。"
    return {
        "query": text,
        "origin": origin,
        "destination": destination,
        "days": days,
        "start_date": start_date,
        "only_region": only_region,
        "note": note,
    }


def check_trip_query(query: str, origin: str = "", destination: str = "") -> str | None:
    """通过返回 None，否则返回给用户看的原因。"""
    text = _normalize_query(query)
    if not text:
        return "请填写出行需求"
    if len(text) > _MAX_LEN:
        return f"需求描述请控制在 {_MAX_LEN} 字以内"
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text):
        return "需求描述包含无法使用的字符"
    if _INJECTION.search(text):
        return "请只描述这次出行，不要写其它指令"
    if _ILLEGAL.search(text):
        return "这段内容和出行路书无关，无法生成"
    # 只拦明显不是出行的话。口语、缺天数、错字留给对话补全，不在这里卡死。
    if not _TRAVEL.search(text) and not _ROUTE.search(text):
        return "请写成出行需求，例如从哪到哪、玩几天"
    return None
