"""高铁 + 到站租车：12306 MCP 查询与路书挂载（失败时静态兜底）。"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import date, timedelta
from typing import Any
from urllib.parse import quote

from mcp_client import call_server_tool_async, has_server

MCP_TIMEOUT_SEC = 14.0


def _hsr_mcp_enabled() -> bool:
    return has_server("12306-mcp") and os.getenv("ROADBOOK_HSR_MCP", "1").strip() not in ("0", "false", "no")


async def _mcp_tool(
    tool_name: str,
    arguments: dict | None = None,
    timeout: float = MCP_TIMEOUT_SEC,
) -> str | None:
    if not _hsr_mcp_enabled():
        return None
    try:
        return await asyncio.wait_for(
            call_server_tool_async("12306-mcp", tool_name, arguments or {}),
            timeout=timeout,
        )
    except Exception:
        return None


# 国铁公开报道中的热门区间（暑运/国庆预售），用于产品默认示范与文案
HSR_PRIORITY_PAIRS: list[dict[str, Any]] = [
    {"origin": "北京", "dest": "上海", "rank": 1, "source": "2024暑运·国庆12306热门区间"},
    {"origin": "广州", "dest": "长沙", "rank": 2, "source": "2024暑运热门线"},
    {"origin": "成都", "dest": "西安", "rank": 3, "source": "2024国庆预售集中区间"},
    {"origin": "北京", "dest": "西安", "rank": 4, "source": "2024暑运热门线"},
    {"origin": "北京", "dest": "成都", "rank": 5, "source": "长线高铁+深度自驾示范"},
    {"origin": "上海", "dest": "杭州", "rank": 6, "source": "长三角短途高铁"},
]

CITY_DEFAULT_STATION: dict[str, str] = {
    "北京": "北京南",
    "上海": "上海虹桥",
    "成都": "成都东",
    "西安": "西安北",
    "广州": "广州南",
    "杭州": "杭州东",
    "长沙": "长沙南",
    "兰州": "兰州西",
    "深圳": "深圳北",
    "重庆": "重庆北",
    "南京": "南京南",
    "武汉": "武汉",
    "郑州": "郑州东",
    "济南": "济南西",
    "青岛": "青岛北",
    "厦门": "厦门北",
    "昆明": "昆明南",
    "贵阳": "贵阳北",
    "天津": "天津西",
    "苏州": "苏州北",
}

FALLBACK_G_TRAINS: dict[tuple[str, str], list[dict[str, Any]]] = {
    ("北京", "成都"): [
        {
            "train_no": "G89",
            "from_station": "北京西",
            "to_station": "成都东",
            "depart": "15:00",
            "arrive": "22:56",
            "duration": "7小时56分",
            "second_class": 778.5,
        },
        {
            "train_no": "G307",
            "from_station": "北京西",
            "to_station": "成都东",
            "depart": "09:10",
            "arrive": "18:53",
            "duration": "9小时43分",
            "second_class": 778.5,
        },
    ],
    ("北京", "上海"): [
        {
            "train_no": "G1",
            "from_station": "北京南",
            "to_station": "上海虹桥",
            "depart": "09:00",
            "arrive": "13:28",
            "duration": "4小时28分",
            "second_class": 553.0,
        },
    ],
    ("成都", "西安"): [
        {
            "train_no": "G2204",
            "from_station": "成都东",
            "to_station": "西安北",
            "depart": "08:12",
            "arrive": "12:04",
            "duration": "3小时52分",
            "second_class": 263.0,
        },
    ],
}

RENTAL_DAILY_BY_LEVEL = {"economy": 180, "comfort": 260, "premium": 420}


def _clean_city(name: str) -> str:
    return re.sub(r"[市省区县州]$", "", (name or "").strip()) or (name or "").strip()


def match_priority_pair(origin: str, dest: str) -> dict[str, Any] | None:
    o, d = _clean_city(origin), _clean_city(dest)
    for row in HSR_PRIORITY_PAIRS:
        if row["origin"] == o and row["dest"] == d:
            return row
        if row["origin"] == d and row["dest"] == o:
            return {**row, "origin": d, "dest": o, "reversed": True}
    return None


def _station_for_city(city: str) -> str:
    c = _clean_city(city)
    return CITY_DEFAULT_STATION.get(c, c)


def _parse_json_blob(text: str) -> Any:
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                return None
    return None


def _normalize_trains(raw: Any, from_st: str, to_st: str) -> list[dict[str, Any]]:
    rows: list[Any] = []
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        for key in ("trains", "data", "result", "tickets"):
            if isinstance(raw.get(key), list):
                rows = raw[key]
                break
        if not rows and raw.get("train_no"):
            rows = [raw]

    out: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        no = (
            item.get("start_train_code")
            or item.get("station_train_code")
            or item.get("trainNo")
            or item.get("train_no")
        )
        if not no:
            continue
        price = (
            item.get("second_class")
            or item.get("secondClass")
            or item.get("ze_price")
            or item.get("price")
        )
        if price in (None, "", "--") and isinstance(item.get("prices"), list):
            for seat in item["prices"]:
                if not isinstance(seat, dict):
                    continue
                if seat.get("short") == "ze" or seat.get("seat_name") == "二等座":
                    price = seat.get("price")
                    break
        try:
            price_f = float(price) if price not in (None, "", "--", "无") else None
        except (TypeError, ValueError):
            price_f = None
        out.append(
            {
                "train_no": str(no),
                "from_station": item.get("from_station") or item.get("fromStation") or from_st,
                "to_station": item.get("to_station") or item.get("toStation") or to_st,
                "depart": str(item.get("depart") or item.get("start_time") or item.get("startTime") or "—"),
                "arrive": str(item.get("arrive") or item.get("arrive_time") or item.get("arriveTime") or "—"),
                "duration": str(item.get("duration") or item.get("lishi") or item.get("run_time") or "—"),
                "second_class": price_f,
            }
        )
    return out[:12]


def _fallback_trains(origin: str, dest: str, from_st: str, to_st: str) -> list[dict[str, Any]]:
    o, d = _clean_city(origin), _clean_city(dest)
    rows = FALLBACK_G_TRAINS.get((o, d)) or FALLBACK_G_TRAINS.get((d, o))
    if rows:
        return [dict(x) for x in rows]
    return [
        {
            "train_no": "G字头参考",
            "from_station": from_st,
            "to_station": to_st,
            "depart": "08:00",
            "arrive": "—",
            "duration": "以 12306 为准",
            "second_class": None,
        }
    ]


def build_booking_url(from_name: str, to_name: str, travel_date: str) -> str:
    """跳转 12306 购票页（余票以官网为准）。"""
    return (
        "https://kyfw.12306.cn/otn/leftTicket/init?"
        f"linktypeid=dc&fs={quote(from_name)},{quote(from_name)}&ts={quote(to_name)},{quote(to_name)}"
        f"&date={travel_date}&flag=N,N,Y"
    )


async def _mcp_current_date() -> str:
    text = await _mcp_tool("get-current-date", {})
    if text:
        try:
            data = _parse_json_blob(text)
            if isinstance(data, dict) and data.get("date"):
                return str(data["date"])[:10]
            if isinstance(data, str) and re.match(r"\d{4}-\d{2}-\d{2}", data):
                return data[:10]
            m = re.search(r"(\d{4}-\d{2}-\d{2})", text or "")
            if m:
                return m.group(1)
        except Exception:
            pass
    # 预售期约 15 天；查票日用「今天+7」更稳（避免当日临期空列表）
    return (date.today() + timedelta(days=7)).isoformat()


async def _resolve_stations(origin: str, dest: str) -> tuple[str, str]:
    from_st = _station_for_city(origin)
    to_st = _station_for_city(dest)
    text = await _mcp_tool(
        "get-station-code-of-citys",
        {"citys": f"{_clean_city(origin)}|{_clean_city(dest)}"},
    )
    if text:
        data = _parse_json_blob(text)
        if isinstance(data, dict):

            def _pick(entry: Any, fallback: str) -> str:
                if isinstance(entry, dict):
                    return str(entry.get("station_name") or entry.get("name") or fallback)
                if isinstance(entry, str) and entry and not re.match(r"^[A-Z]{3}$", entry):
                    return entry
                return fallback

            from_st = _pick(data.get(_clean_city(origin)) or data.get(origin), from_st)
            to_st = _pick(data.get(_clean_city(dest)) or data.get(dest), to_st)
    return from_st, to_st


def middle_via_cities(trip: dict[str, Any]) -> list[str]:
    """路书中间途经城，不含出发地和目的地，保持行进顺序。"""
    origin = _clean_city(str(trip.get("origin") or ""))
    dest = _clean_city(str(trip.get("destination") or ""))
    names: list[str] = []

    def _push(raw: str) -> None:
        name = _clean_city(raw)
        if name and name not in {origin, dest} and name not in names:
            names.append(name)

    # 高铁模式地图只保留起终点，但选票仍按完整兴趣途经
    if (trip.get("prefs") or {}).get("travel_mode") == "hsr_rental":
        for city in trip.get("plan_via_cities") or trip.get("via_cities") or []:
            _push(str(city))
        if names:
            return names

    nodes = trip.get("via_nodes") or []
    if isinstance(nodes, list) and nodes:
        for node in nodes:
            if isinstance(node, dict):
                _push(str(node.get("name") or ""))
        if names:
            return names
    for city in trip.get("via_cities") or []:
        _push(str(city))
    return names


def _norm_city(name: str) -> str:
    return re.sub(r"[市省区县州]$", "", str(name or "").strip()) or ""


def _is_cross_city_drive_item(item: dict[str, Any]) -> bool:
    if item.get("type") != "drive":
        return False
    title = str(item.get("title") or "")
    return "→" in title or "启程" in title


def _collect_explore_templates(days_plan: list[dict[str, Any]], dest: str) -> list[dict[str, Any]]:
    """从原路书中抽取目的地游玩日，去掉跨城赶路段。"""
    out: list[dict[str, Any]] = []
    for d in days_plan:
        kind = d.get("kind")
        if kind == "transit":
            continue
        stay = _norm_city(str(d.get("stay_city") or d.get("from_city") or ""))
        if stay and stay != dest and kind != "county":
            continue
        if kind in ("explore", "county", "arrival") or stay == dest:
            out.append(d)
    if not out:
        out = [d for d in days_plan if d.get("kind") != "transit"]
    return out


def _clone_day_template(template: dict[str, Any], day_no: int, dest: str) -> dict[str, Any]:
    import copy

    day = copy.deepcopy(template)
    day["day"] = day_no
    title = str(day.get("title") or "")
    if "→" in title:
        day["title"] = f"{dest}周边慢游 · 第 {day_no} 日"
    day.pop("date", None)
    day.pop("weekday", None)
    return day


def _build_arrival_day(
    dest: str,
    dest_label: str,
    hsr: dict[str, Any],
    template: dict[str, Any] | None,
) -> dict[str, Any]:
    import copy

    to_st = str(hsr.get("to_station") or dest_label)
    top = (hsr.get("trains") or [{}])[0]
    train_no = str(top.get("train_no") or "").strip()
    train_bit = f"（推荐 {train_no}）" if train_no else ""
    base = copy.deepcopy(template) if template else {"items": [], "kind": "explore"}
    items = [it for it in (base.get("items") or []) if not _is_cross_city_drive_item(it)]
    items.insert(
        0,
        {
            "time": "10:30",
            "type": "tip",
            "priority": "anchor",
            "title": f"高铁抵达 {to_st}",
            "place": to_st,
            "city": dest_label,
            "detail": f"跨城段乘高铁{train_bit}，出站后在租车点取车，再按下方安排游玩。",
            "human_tags": ["#高铁干线", "#到站取车"],
            "id": "hsr-arrival",
        },
    )
    summary = (
        f"乘高铁至{to_st}，出站取租的车。"
        f"{' ' + str(base.get('summary') or '') if base.get('summary') else '首日以轻松打卡为主。'}"
    )
    return {
        "day": 1,
        "title": f"乘高铁抵达 · {dest_label} · 取车开玩",
        "summary": summary.strip(),
        "narrative": summary.strip(),
        "items": items,
        "kind": "arrival",
        "from_city": dest_label,
        "to_city": dest_label,
        "drive_km": 0,
        "drive_hours": 0,
        "stay_city": dest_label,
        "city_vibe": base.get("city_vibe"),
    }


def _local_polyline_from_days(days_plan: list[dict[str, Any]]) -> list[str]:
    coords: list[str] = []
    seen: set[str] = set()

    def _add(loc: str) -> None:
        loc = str(loc or "").strip()
        if loc and loc not in seen:
            seen.add(loc)
            coords.append(loc)

    for d in days_plan:
        for it in d.get("items") or []:
            if it.get("type") in ("sight", "food", "drive", "tip"):
                _add(str(it.get("location") or ""))
    return coords


def reshape_trip_for_hsr_local(trip: dict[str, Any], hsr: dict[str, Any]) -> None:
    """高铁+租车：去掉跨城自驾日程，以目的地为基地重组 days_plan 与地图数据。"""
    from datetime import date, timedelta

    from holidays_cn import holiday_note, weekday_cn
    from trip_planner import _cached_coord

    dest_label = str(trip.get("destination") or "")
    dest = _norm_city(dest_label)
    origin_label = str(trip.get("origin") or "")
    days_target = max(1, int(trip.get("days") or 1))
    days_plan = list(trip.get("days_plan") or [])
    if not days_plan:
        return

    if not trip.get("plan_via_cities"):
        trip["plan_via_cities"] = list(trip.get("via_cities") or [])

    templates = _collect_explore_templates(days_plan, dest)
    if not templates:
        templates = [d for d in days_plan if d.get("kind") != "transit"] or days_plan[-1:]
    seed = templates[0] if templates else days_plan[-1]

    rebuilt: list[dict[str, Any]] = [_build_arrival_day(dest, dest_label, hsr, seed)]
    pool = templates[1:] if len(templates) > 1 else templates
    idx = 0
    while len(rebuilt) < days_target:
        tpl = pool[idx % len(pool)] if pool else seed
        rebuilt.append(_clone_day_template(tpl, len(rebuilt) + 1, dest_label))
        idx += 1

    try:
        trip_start = date.fromisoformat(str(trip.get("start_date") or "").strip())
    except ValueError:
        trip_start = date.today() + timedelta(days=1)
    for d in rebuilt:
        day_no = int(d.get("day") or 1)
        day_date = trip_start + timedelta(days=day_no - 1)
        d["date"] = day_date.isoformat()
        d["weekday"] = weekday_cn(day_date)

    trip["days_plan"] = rebuilt
    trip["transit_days"] = 0
    trip["explore_days"] = days_target

    local_km = int(hsr.get("local_drive_km") or max(80, days_target * 55))
    rental_days = int(hsr.get("rental_days") or days_target)
    trip["distance"] = hsr.get("route_label") or f"高铁+当地约 {local_km}km"
    trip["drive_hours"] = f"当地租车 {rental_days} 天"
    trip["distance_km"] = float(local_km)

    o_loc = str(trip.get("origin_location") or _cached_coord(_norm_city(origin_label)) or "")
    d_loc = str(trip.get("destination_location") or _cached_coord(dest) or "")
    trip["via_nodes"] = [
        {"name": origin_label, "role": "origin", "location": o_loc, "cum_km": 0},
        {"name": dest_label, "role": "destination", "location": d_loc, "cum_km": local_km},
    ]
    trip["polyline"] = _local_polyline_from_days(rebuilt) or ([d_loc] if d_loc else [])
    trip["hsr_local_map"] = True

    top = (hsr.get("trains") or [{}])[0]
    miss = list(top.get("via_miss") or [])
    hsr["local_excursion_vias"] = miss
    if miss:
        tip = f"{'、'.join(miss)}不在本次高铁经停上，可在当地租车日顺路安排。"
        tips = list(trip.get("tips") or [])
        if tip not in tips:
            tips.insert(0, tip)
        trip["tips"] = tips

    hotels = trip.get("hotels") or []
    if hotels:
        trip["hotels"] = [
            {**hotels[0], "name": f"{dest_label}核心商圈酒店", "place": f"{dest_label}高铁站/市区", "note": "到站取车，市区停车选酒店配套车位"}
        ]

    hit = holiday_note(trip_start, days_target)
    if hit:
        trip["holiday_note"] = hit


def _sample_vias(vias: list[str], limit: int = 3) -> list[str]:
    """途经多时取首、中、尾，避免只核对前几座城而漏掉靠近目的地的站。"""
    if len(vias) <= limit:
        return list(vias)
    mid = vias[len(vias) // 2]
    picked = [vias[0], mid, vias[-1]]
    out: list[str] = []
    for name in picked:
        if name not in out:
            out.append(name)
    return out


def _train_codes_from_payload(raw: Any) -> set[str]:
    rows: list[Any] = []
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        for key in ("trains", "data", "result", "tickets"):
            if isinstance(raw.get(key), list):
                rows = raw[key]
                break
    codes: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        no = item.get("start_train_code") or item.get("station_train_code") or item.get("train_no")
        if no:
            codes.add(str(no).strip())
    return codes


def _pick_via_station(city: str, found: dict[str, str]) -> str | None:
    """在查到的站名里挑这座城的高铁站：北/东优先，其次同名站，再次古城。"""
    city = _clean_city(city)
    by_name = {str(name).replace(" ", ""): str(name).replace(" ", "") for name in found.values()}
    order = [f"{city}北", f"{city}东", city, f"{city}古城", f"{city}南", f"{city}西"]
    default = CITY_DEFAULT_STATION.get(city, "").replace(" ", "")
    if default:
        order.append(default)
    for name in order:
        if name and name in by_name:
            return by_name[name]
    return None


async def _resolve_via_stations(vias: list[str]) -> dict[str, str]:
    """一次把途经城可能的站名问完，返回 {城市: 车站名}。"""
    if not vias:
        return {}
    guesses: list[str] = []
    for city in vias:
        for name in (f"{city}北", f"{city}东", city, f"{city}古城", f"{city}南", f"{city}西"):
            if name not in guesses:
                guesses.append(name)
        default = CITY_DEFAULT_STATION.get(city)
        if default and default not in guesses:
            guesses.append(default)
    text = await _mcp_tool(
        "get-station-code-by-names",
        {"stationNames": "|".join(guesses)},
        timeout=8.0,
    )
    found: dict[str, str] = {}
    data = _parse_json_blob(text or "")
    if isinstance(data, dict):
        for key, entry in data.items():
            if not isinstance(entry, dict) or entry.get("error"):
                continue
            station = str(entry.get("station_name") or key).replace(" ", "")
            if station:
                found[station] = station
    return {city: station for city in vias if (station := _pick_via_station(city, found))}


def annotate_trains_with_via(
    trains: list[dict[str, Any]],
    served_by_code: dict[str, list[str]],
    checked: list[str],
) -> list[dict[str, Any]]:
    """经停越多的班次越靠前；经停数相同则保持 12306 原顺序。"""
    ranked: list[dict[str, Any]] = []
    for index, train in enumerate(trains):
        code = str(train.get("train_no") or "").strip()
        got = set(served_by_code.get(code) or [])
        hits = [city for city in checked if city in got]
        miss = [city for city in checked if city not in got]
        row = dict(train)
        row["via_hits"] = hits
        row["via_miss"] = miss
        if hits:
            row["via_label"] = "经停 " + "、".join(hits)
        elif checked:
            row["via_label"] = "不经停途经城市"
        else:
            row["via_label"] = ""
        row["_ord"] = index
        ranked.append(row)
    ranked.sort(key=lambda row: (-len(row["via_hits"]), row["_ord"]))
    for row in ranked:
        row.pop("_ord", None)
    return ranked


def _via_note(
    checked: list[str],
    failed: list[str],
    skipped: list[str],
    trains: list[dict[str, Any]],
    live: bool,
) -> str:
    if not live:
        return "这次用的是参考班次，还没按途经城市对上实时车次。"
    top = trains[0] if trains else {}
    hits = list(top.get("via_hits") or [])
    miss = [city for city in checked if city not in hits]
    parts: list[str] = []
    if hits:
        parts.append(f"已按途经重排，推荐班次经停{'、'.join(hits)}")
    if miss:
        parts.append(f"{'、'.join(miss)}没有同车经停，到站后开车去")
    if failed:
        parts.append(f"{'、'.join(failed)}的车站这次没查到")
    if skipped:
        parts.append(f"{'、'.join(skipped)}没来得及核对")
    return "。".join(parts) + ("。" if parts else "")


async def _match_vias_on_trains(
    from_st: str,
    travel_date: str,
    trains: list[dict[str, Any]],
    vias: list[str],
) -> tuple[dict[str, list[str]], list[str], list[str], list[str]]:
    """用「出发站 → 途经城车站」的余票车次，判断直达班次是否经停这些城。"""
    served: dict[str, list[str]] = {str(t.get("train_no") or "").strip(): [] for t in trains}
    codes = set(served)
    if not vias or not codes or not _hsr_mcp_enabled():
        return served, [], list(vias), []
    stations = await _resolve_via_stations(vias)
    checked: list[str] = []
    failed: list[str] = []
    skipped: list[str] = []
    deadline = time.monotonic() + 18.0
    # 先核对靠近目的地的城，超时也尽量留下最可能同车的站
    for city in reversed(vias):
        if time.monotonic() > deadline:
            skipped.extend(c for c in vias if c not in checked and c not in failed and c not in skipped)
            break
        station = stations.get(city)
        if not station or station == from_st:
            failed.append(city)
            continue
        text = await _mcp_tool(
            "get-tickets",
            {
                "date": travel_date,
                "fromStation": from_st,
                "toStation": station,
                "format": "json",
                "trainFilterFlags": "G",
                "limitedNum": 0,
            },
            timeout=8.0,
        )
        if not text or text.startswith("Error"):
            failed.append(city)
            continue
        if "没有查询到" in text or "未查询到" in text:
            checked.append(city)
            continue
        parsed = _parse_json_blob(text)
        if parsed is None:
            failed.append(city)
            continue
        hit_codes = codes & _train_codes_from_payload(parsed)
        checked.append(city)
        for code in hit_codes:
            served[code].append(city)
    checked.sort(key=vias.index)
    return served, checked, failed, skipped


async def fetch_hsr_trains(
    origin: str,
    dest: str,
    *,
    travel_date: str | None = None,
    pax: int = 2,
    via_cities: list[str] | None = None,
) -> dict[str, Any]:
    """查询 G 字头，并按途经城市是否同车经停重排；MCP 失败时返回静态参考班次。"""
    travel_date = travel_date or await _mcp_current_date()
    from_st, to_st = await _resolve_stations(origin, dest)
    source = "12306-mcp"
    trains: list[dict[str, Any]] = []
    err: str | None = None
    live = False

    if _hsr_mcp_enabled():
        # 当天临近发车经常返回空列表，改查一周后，否则途经核对不会发生
        for attempt_date in (travel_date, (date.today() + timedelta(days=7)).isoformat()):
            if attempt_date != travel_date and trains:
                break
            text = await _mcp_tool(
                "get-tickets",
                {
                    "date": attempt_date,
                    "fromStation": from_st,
                    "toStation": to_st,
                    "format": "json",
                    "trainFilterFlags": "G",
                },
            )
            if text:
                parsed = _parse_json_blob(text)
                trains = _normalize_trains(parsed, from_st, to_st)
                if trains:
                    travel_date = attempt_date
                    live = True
                    break
            else:
                err = "12306 MCP 超时或网络不可用"
                break

    if not trains:
        source = "fallback"
        trains = _fallback_trains(origin, dest, from_st, to_st)
        if err:
            source = f"fallback（{err[:80]}）"
        live = False

    origin_c, dest_c = _clean_city(origin), _clean_city(dest)
    vias: list[str] = []
    for city in via_cities or []:
        name = _clean_city(str(city))
        if name and name not in {origin_c, dest_c} and name not in vias:
            vias.append(name)
    sampled = _sample_vias(vias, 3)
    checked: list[str] = []
    failed: list[str] = []
    skipped: list[str] = []
    if live and sampled:
        served, checked, failed, skipped = await _match_vias_on_trains(
            from_st, travel_date, trains, sampled
        )
        trains = annotate_trains_with_via(trains, served, checked)
    else:
        trains = annotate_trains_with_via(trains, {}, [])

    shown = trains[:3]
    priced = next((t for t in shown if t.get("second_class")), None)
    if priced is None:
        priced = next((t for t in trains if t.get("second_class")), None)
    ref_price = float(priced["second_class"]) if priced and priced.get("second_class") else 520.0
    note = _via_note(checked, failed, skipped, shown, live) if sampled else ""

    return {
        "origin": origin_c,
        "destination": dest_c,
        "from_station": from_st,
        "to_station": to_st,
        "travel_date": travel_date,
        "pax": max(1, min(5, int(pax or 2))),
        "trains": shown,
        "reference_second_class": ref_price,
        "booking_url": build_booking_url(from_st, to_st, travel_date),
        "source": source,
        "priority": match_priority_pair(origin, dest),
        "via_cities": sampled,
        "via_note": note,
    }


def _highlight_line(hsr: dict[str, Any]) -> str:
    top = (hsr.get("trains") or [{}])[0]
    rental_days = hsr.get("rental_days") or ""
    pri = hsr.get("priority") or {}
    pri_note = f"（{pri['source']}）" if isinstance(pri, dict) and pri.get("source") else ""
    via_note = str(hsr.get("via_note") or "").strip()
    train_line = ""
    if top.get("train_no"):
        # 经停说明已经写在 via_note 里，这里不再重复
        label = "" if via_note else (top.get("via_label") or "")
        extra = f"，{label}" if label else ""
        train_line = f"推荐 {top['train_no']} {top.get('from_station')}→{top.get('to_station')}{extra}，"
    tail = via_note or f"余票与时刻以 12306 为准{pri_note}。"
    return f"{train_line}到站后租 {rental_days} 天车深度玩目的地周边。{tail}"


async def refresh_hsr_for_vias(trip: dict[str, Any]) -> None:
    """途经变化后按新的途经城重查车票。查失败就保留原来的班次。"""
    hsr = trip.get("hsr")
    if not isinstance(hsr, dict):
        return
    if (trip.get("prefs") or {}).get("travel_mode") != "hsr_rental":
        return
    sampled = _sample_vias(middle_via_cities(trip), 3)
    origin = str(trip.get("origin") or hsr.get("origin") or "")
    dest = str(trip.get("destination") or hsr.get("destination") or "")
    travel_date = str(trip.get("start_date") or hsr.get("travel_date") or "") or None
    same_od = hsr.get("origin") == origin and hsr.get("destination") == dest
    same_date = not travel_date or hsr.get("travel_date") == travel_date
    if list(hsr.get("via_cities") or []) == sampled and "via_note" in hsr and same_od and same_date:
        return
    try:
        fresh = await fetch_hsr_trains(
            origin,
            dest,
            travel_date=travel_date,
            pax=int(hsr.get("pax") or 2),
            via_cities=middle_via_cities(trip),
        )
    except Exception:
        return
    for key in (
        "rental_days",
        "rental_daily",
        "rental_total",
        "local_drive_km",
        "local_drive_hint",
        "route_label",
        "mode_label",
    ):
        if key in hsr:
            fresh[key] = hsr[key]
    trip["hsr"] = fresh
    _merge_hsr_budget(trip, fresh)
    trip["highlight"] = _highlight_line(fresh)
    reshape_trip_for_hsr_local(trip, fresh)
    from trip_planner import attach_local_transit

    attach_local_transit(trip)


def _merge_hsr_budget(trip: dict[str, Any], hsr: dict[str, Any]) -> None:
    budget = trip.setdefault("budget", {})
    pax = int(hsr.get("pax") or budget.get("pax") or 2)
    per_ticket = float(hsr.get("reference_second_class") or 520)
    ticket_total = int(round(per_ticket * pax))
    rental_days = max(1, int(hsr.get("rental_days") or 1))
    rental_daily = int(hsr.get("rental_daily") or 260)
    rental_total = rental_days * rental_daily

    budget["hsr_tickets"] = ticket_total
    budget["car_rental"] = rental_total
    budget["local_drive_km"] = int(hsr.get("local_drive_km") or 0)
    hsr["ticket_total"] = ticket_total
    hsr["rental_total"] = rental_total
    hsr["combined_extra"] = ticket_total + rental_total


async def attach_hsr_rental_to_trip(
    trip: dict[str, Any],
    origin: str,
    dest: str,
    *,
    days: int = 7,
    pax: int = 2,
    budget_level: str = "comfort",
    travel_date: str | None = None,
) -> dict[str, Any]:
    """写入 trip.hsr，并微调标题/亮点/预算（当地租车 + 高铁票）。"""
    vias = middle_via_cities(trip)
    existing = trip.get("hsr") if isinstance(trip.get("hsr"), dict) else None
    if (
        existing
        and trip.get("prefs", {}).get("travel_mode") == "hsr_rental"
        and existing.get("via_cities") == _sample_vias(vias, 3)
        and "via_note" in existing
    ):
        hsr = existing
    else:
        hsr = await fetch_hsr_trains(
            origin, dest, travel_date=travel_date, pax=pax, via_cities=vias
        )
    rental_days = max(1, min(int(days or 7), 14))
    rental_daily = RENTAL_DAILY_BY_LEVEL.get(budget_level, 260)
    local_km = max(80, rental_days * 55)
    hsr["rental_days"] = rental_days
    hsr["rental_daily"] = rental_daily
    hsr["local_drive_km"] = local_km
    hsr["local_drive_hint"] = f"当地约 {local_km}km"
    hsr["route_label"] = f"高铁+当地 {local_km}km"
    hsr["mode_label"] = "高铁 + 到站租车"

    trip["hsr"] = hsr
    prefs = trip.setdefault("prefs", {})
    prefs["travel_mode"] = "hsr_rental"
    trip["title"] = f"{_clean_city(origin)} → {_clean_city(dest)} {days} 日 · 高铁+租车"
    trip["highlight"] = _highlight_line(hsr)

    reshape_trip_for_hsr_local(trip, hsr)
    _merge_hsr_budget(trip, hsr)
    from trip_planner import attach_local_transit

    attach_local_transit(trip)
    return trip
