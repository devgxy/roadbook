"""中国法定节假日参考数据（内置静态表）。

数据说明：
- 2026 年为按惯例推算的近似安排，2027 年为按农历推算的预估；
- 上线前应替换为国务院办公厅每年发布的准确放假安排；
- 高速免费通行适用于春节、清明节、劳动节、国庆节（7 座及以下小客车）。
"""

from __future__ import annotations

from datetime import date, timedelta

HOLIDAYS: list[tuple[str, date, date, bool]] = [
    ("元旦", date(2026, 1, 1), date(2026, 1, 3), False),
    ("春节", date(2026, 2, 15), date(2026, 2, 22), True),
    ("清明节", date(2026, 4, 4), date(2026, 4, 6), True),
    ("劳动节", date(2026, 5, 1), date(2026, 5, 5), True),
    ("端午节", date(2026, 6, 19), date(2026, 6, 21), False),
    ("中秋节", date(2026, 9, 25), date(2026, 9, 27), False),
    ("国庆节", date(2026, 10, 1), date(2026, 10, 7), True),
    ("元旦", date(2027, 1, 1), date(2027, 1, 3), False),
    ("春节", date(2027, 2, 5), date(2027, 2, 11), True),
    ("清明节", date(2027, 4, 4), date(2027, 4, 6), True),
    ("劳动节", date(2027, 5, 1), date(2027, 5, 4), True),
    ("端午节", date(2027, 6, 9), date(2027, 6, 11), False),
    ("中秋节", date(2027, 9, 15), date(2027, 9, 17), False),
    ("国庆节", date(2027, 10, 1), date(2027, 10, 7), True),
]

_WEEKDAY_CN = "一二三四五六日"


def weekday_cn(d: date) -> str:
    return "周" + _WEEKDAY_CN[d.weekday()]


def fmt_md(d: date) -> str:
    return f"{d.month}/{d.day:02d}"


def holiday_name(d: date) -> str | None:
    for name, start, end, _ in HOLIDAYS:
        if start <= d <= end:
            return name
    return None


def trip_holidays(start: date, days: int) -> dict[str, list[date]]:
    """行程覆盖到的节假日：名称 -> [首日, 末日]。"""
    hits: dict[str, list[date]] = {}
    for i in range(max(1, days)):
        d = start + timedelta(days=i)
        name = holiday_name(d)
        if not name:
            continue
        if name in hits:
            hits[name][0] = min(hits[name][0], d)
            hits[name][1] = max(hits[name][1], d)
        else:
            hits[name] = [d, d]
    return hits


def _free_highway(name: str) -> bool:
    return any(name == h[0] and h[3] for h in HOLIDAYS)


def holiday_note(start: date, days: int) -> str | None:
    """行程撞上节假日时给出的一句行动提示；没撞上返回 None。"""
    hits = trip_holidays(start, days)
    if not hits:
        return None
    parts = []
    for name, (s, e) in hits.items():
        span = f"{fmt_md(s)}–{fmt_md(e)}" if s != e else fmt_md(s)
        parts.append(f"{name}（{span}）")
    notes = [f"行程与{'、'.join(parts)}重叠"]
    if any(_free_highway(n) for n in hits):
        notes.append("假期高速免费但车流集中，服务区易饱和，建议早出发错峰")
    notes.append("热门景区需提前预约，酒店与租车价格上浮，尽早锁定")
    return "；".join(notes) + "。"