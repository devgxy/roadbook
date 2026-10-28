"""意见反馈与使用埋点。只记行为次数和短上下文，不存完整路书。"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

_CST = timezone(timedelta(hours=8))
_ROOT = Path(__file__).resolve().parent
_DIR = _ROOT / "data" / "insights"
_FEEDBACK = _DIR / "feedback.jsonl"
_EVENTS = _DIR / "events.jsonl"
_LOCK = _DIR / "insights.lock"
_MAX_LINES = 8000
_EVENT_NAMES = {
    "page_view",
    "plan_start",
    "plan_done",
    "plan_fail",
    "chat_edit",
    "poster_open",
    "phone_preview",
    "share_view",
    "history_open",
    "feedback_open",
}
_CATEGORIES = {"不准", "难用", "想要功能", "其他"}


def _secret() -> bytes:
    sec = os.getenv("ROADBOOK_AUTH_SECRET", "").strip() or os.getenv("DASHSCOPE_API_KEY", "").strip() or "roadbook-dev-secret"
    return sec.encode("utf-8")


def admin_configured() -> bool:
    return bool(os.getenv("ROADBOOK_ADMIN_PASSWORD", "").strip())


def admin_password_ok(password: str) -> bool:
    expect = os.getenv("ROADBOOK_ADMIN_PASSWORD", "").strip()
    if not expect or not password:
        return False
    return hmac.compare_digest(expect, password)


def make_admin_token(ttl_sec: int = 7 * 86400) -> str:
    exp = int(time.time()) + ttl_sec
    payload = json.dumps({"role": "admin", "exp": exp}, separators=(",", ":")).encode("utf-8")
    sig = hmac.new(_secret(), payload, hashlib.sha256).digest()
    return urlsafe_b64encode(payload).decode("ascii") + "." + urlsafe_b64encode(sig).decode("ascii")


def admin_token_ok(token: str) -> bool:
    if not token or "." not in token:
        return False
    body, tag = token.rsplit(".", 1)
    try:
        payload = urlsafe_b64decode(body.encode("ascii"))
        sig = urlsafe_b64decode(tag.encode("ascii"))
    except Exception:
        return False
    if not hmac.compare_digest(hmac.new(_secret(), payload, hashlib.sha256).digest(), sig):
        return False
    try:
        data = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return False
    return data.get("role") == "admin" and int(data.get("exp") or 0) >= int(time.time())


def _day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), _CST).strftime("%Y-%m-%d")


def _append(path: Path, row: dict[str, Any]) -> None:
    _DIR.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
    with open(_LOCK, "a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            _trim(path)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _trim(path: Path) -> None:
    if not path.exists() or path.stat().st_size < 1_500_000:
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) <= _MAX_LINES:
        return
    path.write_text("\n".join(lines[-_MAX_LINES:]) + "\n", encoding="utf-8")


def _read(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _count_today(path: Path, key: str, value: str) -> int:
    today = _day()
    n = 0
    for row in _read(path):
        if str(row.get("day") or "") == today and str(row.get(key) or "") == value:
            n += 1
    return n


def add_feedback(text: str, category: str, phone_masked: str, ip: str) -> dict[str, Any]:
    text = " ".join(str(text or "").split())
    if len(text) < 4:
        return {"ok": False, "message": "请至少写 4 个字"}
    if len(text) > 800:
        text = text[:800]
    if category not in _CATEGORIES:
        category = "其他"
    who = phone_masked or ip or "anon"
    if _count_today(_FEEDBACK, "who", who) >= 5:
        return {"ok": False, "message": "今天反馈次数已用完，明天再来"}
    row = {
        "id": hashlib.sha256(f"{time.time()}:{who}:{text}".encode()).hexdigest()[:12],
        "at": int(time.time()),
        "day": _day(),
        "category": category,
        "text": text,
        "phone": phone_masked,
        "who": who,
    }
    _append(_FEEDBACK, row)
    return {"ok": True, "message": "已收到，谢谢"}


def add_event(name: str, props: dict[str, Any] | None, phone_masked: str, ip: str) -> dict[str, Any]:
    if name not in _EVENT_NAMES:
        return {"ok": False, "message": "未知事件"}
    who = phone_masked or ip or "anon"
    if _count_today(_EVENTS, "who", who) >= 400:
        return {"ok": True, "dropped": True}
    clean: dict[str, Any] = {}
    src = props if isinstance(props, dict) else {}
    mode = str(src.get("travel_mode") or "")[:24]
    if mode:
        clean["travel_mode"] = mode
    if src.get("days") is not None:
        try:
            clean["days"] = max(1, min(14, int(src.get("days"))))
        except (TypeError, ValueError):
            pass
    if "ok" in src:
        clean["ok"] = bool(src.get("ok"))
    _append(
        _EVENTS,
        {
            "at": int(time.time()),
            "day": _day(),
            "name": name,
            "props": clean,
            "phone": phone_masked,
            "who": who,
        },
    )
    return {"ok": True}


def summary() -> dict[str, Any]:
    events = _read(_EVENTS)
    feedback = _read(_FEEDBACK)
    days = [(_day(time.time() - i * 86400)) for i in range(6, -1, -1)]
    by_day: dict[str, Counter[str]] = {d: Counter() for d in days}
    people: dict[str, set[str]] = {d: set() for d in days}
    modes: Counter[str] = Counter()
    for row in events:
        day = str(row.get("day") or "")
        name = str(row.get("name") or "")
        if day in by_day and name:
            by_day[day][name] += 1
            if row.get("who"):
                people[day].add(str(row["who"]))
        if name == "plan_done":
            mode = str((row.get("props") or {}).get("travel_mode") or "")
            if mode:
                modes[mode] += 1
    series = []
    for day in days:
        c = by_day[day]
        series.append(
            {
                "day": day,
                "people": len(people[day]),
                "page_view": c.get("page_view", 0),
                "plan_start": c.get("plan_start", 0),
                "plan_done": c.get("plan_done", 0),
                "plan_fail": c.get("plan_fail", 0),
                "chat_edit": c.get("chat_edit", 0),
                "poster_open": c.get("poster_open", 0),
                "share_view": c.get("share_view", 0),
                "phone_preview": c.get("phone_preview", 0),
            }
        )
    cats: Counter[str] = Counter(str(r.get("category") or "其他") for r in feedback)
    recent = list(reversed(feedback[-80:]))
    return {
        "ok": True,
        "series": series,
        "modes": dict(modes),
        "feedback_total": len(feedback),
        "feedback_categories": dict(cats),
        "feedback": recent,
    }


def export_rows(kind: str) -> list[dict[str, Any]]:
    if kind == "events":
        return _read(_EVENTS)
    return _read(_FEEDBACK)
