"""路书公开分享：写入 data/shares，扫码可看完整行程（无需登录）。"""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_SHARE_DIR = _ROOT / "data" / "shares"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,24}$")
_MAX_BYTES = 2_500_000
_TTL_SEC = 90 * 86400


def _path(share_id: str) -> Path:
    return _SHARE_DIR / f"{share_id}.json"


def create_share(trip: dict[str, Any], owner_phone: str = "") -> dict[str, Any]:
    if not isinstance(trip, dict) or not trip:
        return {"ok": False, "message": "缺少路书数据"}
    # 去掉仅前端态字段
    clean = {k: v for k, v in trip.items() if not str(k).startswith("_")}
    share_id = secrets.token_urlsafe(9)
    payload = {
        "id": share_id,
        "created_at": int(time.time()),
        "expires_at": int(time.time()) + _TTL_SEC,
        "owner": owner_phone or "",
        "trip": clean,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode("utf-8")) > _MAX_BYTES:
        return {"ok": False, "message": "路书过大，无法生成分享"}
    _SHARE_DIR.mkdir(parents=True, exist_ok=True)
    _path(share_id).write_text(raw, encoding="utf-8")
    return {"ok": True, "id": share_id, "path": f"/s/{share_id}"}


def load_share(share_id: str) -> dict[str, Any] | None:
    if not _ID_RE.match(share_id or ""):
        return None
    fp = _path(share_id)
    if not fp.exists():
        return None
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    exp = int(data.get("expires_at") or 0)
    if exp and exp < int(time.time()):
        try:
            fp.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    trip = data.get("trip")
    if not isinstance(trip, dict):
        return None
    return {
        "id": share_id,
        "created_at": int(data.get("created_at") or 0),
        "trip": trip,
    }
