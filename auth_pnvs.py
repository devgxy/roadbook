"""阿里云号码认证 · 短信认证 + 限频 + 会话缓存。"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

_log = logging.getLogger("roadbook.security")

_PHONE_RE = re.compile(r"^1\d{10}$")
_CST = timezone(timedelta(hours=8))
_SEND_INTERVAL_SEC = 60
_DAILY_SEND_LIMIT = 10
_IP_DAILY_SEND = 20
_VERIFY_FAIL_MAX = 5
_VERIFY_LOCK_SEC = 15 * 60
_IP_VERIFY_PER_MIN = 10
_PLAN_DAILY = 20
_CHAT_DAILY = 40
_SESSION_TTL_SEC = 30 * 86400
_CAPTCHA_TTL = 300
_CAPTCHA_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_ROOT = Path(__file__).resolve().parent
_STORE_PATH = _ROOT / "data" / "auth_store.json"
_LOCK_PATH = _ROOT / "data" / "auth_store.lock"
_store: dict[str, Any] | None = None
_inflight_guard = threading.Lock()
_inflight: dict[str, dict[str, int]] = {"plan": {}, "chat": {}}


def _cfg(name: str) -> str:
    return os.getenv(name, "").strip()


def pnvs_configured() -> bool:
    return bool(
        _cfg("ALIBABA_CLOUD_ACCESS_KEY_ID")
        and _cfg("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        and _cfg("PNVS_SMS_SIGN_NAME")
        and _cfg("PNVS_SMS_TEMPLATE_CODE")
    )


def normalize_phone(raw: str) -> str | None:
    s = re.sub(r"\D", "", str(raw or ""))
    if s.startswith("86") and len(s) == 13:
        s = s[2:]
    if not _PHONE_RE.match(s):
        return None
    return s


def mask_phone(phone: str) -> str:
    if len(phone) != 11:
        return "***"
    return f"{phone[:3]}****{phone[-4:]}"


def _auth_secret() -> bytes:
    sec = _cfg("ROADBOOK_AUTH_SECRET") or _cfg("DASHSCOPE_API_KEY") or "roadbook-dev-secret"
    return sec.encode("utf-8")


def _today_key() -> str:
    return datetime.now(_CST).strftime("%Y-%m-%d")


def _empty_store() -> dict[str, Any]:
    return {
        "sends": {},
        "sessions": {},
        "verify": {},
        "ip_send": {},
        "usage": {},
        "captchas": {},
    }


def _normalize_store(data: dict[str, Any]) -> dict[str, Any]:
    base = _empty_store()
    if isinstance(data, dict):
        base.update({k: v for k, v in data.items() if isinstance(v, dict)})
    for key in _empty_store():
        if not isinstance(base.get(key), dict):
            base[key] = {}
    return base


def _read_disk() -> dict[str, Any]:
    if not _STORE_PATH.exists():
        return _empty_store()
    try:
        data = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_store()
    return _normalize_store(data if isinstance(data, dict) else {})


def _write_disk(data: dict[str, Any]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(_STORE_PATH)


class _StoreLock:
    """线程锁 + 文件锁。进入临界区时从磁盘刷新，离开时写回，多进程计数不会互相覆盖。"""

    def __init__(self) -> None:
        self._thread = threading.RLock()
        self._depth = 0
        self._fh: Any = None

    def __enter__(self) -> "_StoreLock":
        global _store
        self._thread.acquire()
        if self._depth == 0:
            _LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(_LOCK_PATH, "a+", encoding="utf-8")
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
            _store = _read_disk()
        self._depth += 1
        return self

    def __exit__(self, *_exc: object) -> None:
        global _store
        self._depth -= 1
        if self._depth == 0:
            try:
                if _store is not None:
                    _write_disk(_store)
            finally:
                if self._fh is not None:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
                    self._fh.close()
                    self._fh = None
        self._thread.release()


_lock = _StoreLock()


def _load_store() -> dict[str, Any]:
    global _store
    with _lock:
        if _store is None:
            _store = _read_disk()
        return _store


def _save_store() -> None:
    with _lock:
        if _store is not None:
            _write_disk(_store)


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_session_token(phone: str, ttl_sec: int = _SESSION_TTL_SEC) -> str:
    exp = int(time.time()) + ttl_sec
    payload = json.dumps({"phone": phone, "exp": exp}, separators=(",", ":"))
    sig = hmac.new(_auth_secret(), payload.encode("utf-8"), hashlib.sha256).digest()
    body = urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")
    tag = urlsafe_b64encode(sig).decode("ascii")
    return f"{body}.{tag}"


def parse_session_token(token: str) -> str | None:
    """仅校验 HMAC 与过期；完整登录态请用 resolve_session。"""
    if not token or "." not in token:
        return None
    body, tag = token.rsplit(".", 1)
    try:
        payload_b = urlsafe_b64decode(body.encode("ascii"))
        sig = urlsafe_b64decode(tag.encode("ascii"))
    except Exception:
        return None
    if not hmac.compare_digest(hmac.new(_auth_secret(), payload_b, hashlib.sha256).digest(), sig):
        return None
    try:
        data = json.loads(payload_b.decode("utf-8"))
    except json.JSONDecodeError:
        return None
    if int(data.get("exp") or 0) < int(time.time()):
        return None
    return normalize_phone(str(data.get("phone") or ""))


def create_session(phone: str, ttl_sec: int = _SESSION_TTL_SEC) -> str:
    token = make_session_token(phone, ttl_sec=ttl_sec)
    digest = _token_digest(token)
    exp = int(time.time()) + ttl_sec
    with _lock:
        store = _load_store()
        sessions: dict[str, Any] = store.setdefault("sessions", {})
        now = int(time.time())
        expired = [k for k, v in sessions.items() if int((v or {}).get("exp") or 0) < now]
        for k in expired:
            sessions.pop(k, None)
        sessions[digest] = {"phone": phone, "exp": exp}
        _save_store()
    return token


def resolve_session(token: str) -> str | None:
    phone = parse_session_token(token)
    if not phone:
        return None
    digest = _token_digest(token)
    with _lock:
        store = _load_store()
        sessions: dict[str, Any] = store.setdefault("sessions", {})
        row = sessions.get(digest)
        if not isinstance(row, dict):
            return None
        if int(row.get("exp") or 0) < int(time.time()):
            sessions.pop(digest, None)
            _save_store()
            return None
        if normalize_phone(str(row.get("phone") or "")) != phone:
            return None
        return phone


def revoke_session(token: str) -> None:
    if not token:
        return
    digest = _token_digest(token)
    with _lock:
        store = _load_store()
        sessions: dict[str, Any] = store.setdefault("sessions", {})
        if digest in sessions:
            sessions.pop(digest, None)
            _save_store()


def _send_quota(phone: str) -> dict[str, Any]:
    """读取发码配额（不修改）。"""
    today = _today_key()
    with _lock:
        store = _load_store()
        sends: dict[str, Any] = store.setdefault("sends", {})
        row = sends.get(phone)
        if not isinstance(row, dict) or str(row.get("day") or "") != today:
            return {
                "count": 0,
                "remaining": _DAILY_SEND_LIMIT,
                "retry_after": 0,
                "last_sent": 0,
            }
        last = float(row.get("last_sent") or 0)
        elapsed = time.time() - last
        retry = max(0, int(_SEND_INTERVAL_SEC - elapsed)) if last else 0
        count = int(row.get("count") or 0)
        return {
            "count": count,
            "remaining": max(0, _DAILY_SEND_LIMIT - count),
            "retry_after": retry,
            "last_sent": last,
        }


def _reserve_send(phone: str, ip: str = "") -> dict[str, Any] | None:
    """预占一次发码额度（手机号 + IP）；失败返回错误 dict，成功返回 None。"""
    today = _today_key()
    ip = (ip or "unknown")[:64]
    with _lock:
        store = _load_store()
        sends: dict[str, Any] = store.setdefault("sends", {})
        row = sends.get(phone)
        if not isinstance(row, dict) or str(row.get("day") or "") != today:
            row = {"day": today, "count": 0, "last_sent": 0}
        last = float(row.get("last_sent") or 0)
        if last:
            elapsed = time.time() - last
            if elapsed < _SEND_INTERVAL_SEC:
                wait = max(1, int(_SEND_INTERVAL_SEC - elapsed + 0.999))
                remaining = max(0, _DAILY_SEND_LIMIT - int(row.get("count") or 0))
                return {
                    "ok": False,
                    "message": f"发送过于频繁，请 {wait} 秒后再试",
                    "retry_after": wait,
                    "remaining": remaining,
                }
        count = int(row.get("count") or 0)
        if count >= _DAILY_SEND_LIMIT:
            return {
                "ok": False,
                "message": "今日验证码次数已用完（每日最多 10 次）",
                "retry_after": 0,
                "remaining": 0,
            }
        ip_sends: dict[str, Any] = store.setdefault("ip_send", {})
        ip_row = ip_sends.get(ip)
        if not isinstance(ip_row, dict) or str(ip_row.get("day") or "") != today:
            ip_row = {"day": today, "count": 0}
        if int(ip_row.get("count") or 0) >= _IP_DAILY_SEND:
            _log.warning("sms_ip_cap ip=%s", ip)
            return {
                "ok": False,
                "message": "当前网络今日发码次数已达上限，请明天再试",
                "retry_after": 0,
                "remaining": max(0, _DAILY_SEND_LIMIT - count),
            }
        row = {
            "day": today,
            "count": count + 1,
            "last_sent": time.time(),
            "out_id": str(row.get("out_id") or ""),
        }
        sends[phone] = row
        ip_row = {"day": today, "count": int(ip_row.get("count") or 0) + 1}
        ip_sends[ip] = ip_row
        _save_store()
        return None


def _rollback_send(phone: str, ip: str = "") -> None:
    today = _today_key()
    ip = (ip or "unknown")[:64]
    with _lock:
        store = _load_store()
        sends: dict[str, Any] = store.setdefault("sends", {})
        row = sends.get(phone)
        if isinstance(row, dict) and str(row.get("day") or "") == today:
            row["count"] = max(0, int(row.get("count") or 0) - 1)
            row["last_sent"] = 0
            sends[phone] = row
        ip_sends: dict[str, Any] = store.setdefault("ip_send", {})
        ip_row = ip_sends.get(ip)
        if isinstance(ip_row, dict) and str(ip_row.get("day") or "") == today:
            ip_row["count"] = max(0, int(ip_row.get("count") or 0) - 1)
            ip_sends[ip] = ip_row
        _save_store()


def _set_out_id(phone: str, out_id: str) -> None:
    today = _today_key()
    with _lock:
        store = _load_store()
        sends: dict[str, Any] = store.setdefault("sends", {})
        row = sends.get(phone)
        if not isinstance(row, dict) or str(row.get("day") or "") != today:
            row = {"day": today, "count": 1, "last_sent": time.time()}
        row["out_id"] = out_id
        row["out_expires"] = time.time() + 600
        sends[phone] = row
        _save_store()


def _get_out_id(phone: str) -> str:
    with _lock:
        store = _load_store()
        row = store.get("sends", {}).get(phone) or {}
        if not isinstance(row, dict):
            return ""
        if float(row.get("out_expires") or 0) < time.time():
            return ""
        return str(row.get("out_id") or "")


def _captcha_svg(code: str) -> str:
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="44" viewBox="0 0 128 44">',
        '<rect width="128" height="44" rx="8" fill="#f4efe6"/>',
    ]
    for i in range(4):
        y1 = secrets.randbelow(40) + 2
        y2 = secrets.randbelow(40) + 2
        parts.append(
            f'<line x1="{i * 30}" y1="{y1}" x2="{30 + i * 30}" y2="{y2}" stroke="#c4b8a4" stroke-width="1"/>'
        )
    for i, ch in enumerate(code):
        x = 14 + i * 28
        y = 30 + secrets.randbelow(6) - 3
        rot = secrets.randbelow(21) - 10
        parts.append(
            f'<text x="{x}" y="{y}" fill="#1c1916" font-size="22" font-family="ui-monospace,monospace" '
            f'transform="rotate({rot} {x} {y})">{ch}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def issue_captcha() -> dict[str, Any]:
    code = "".join(secrets.choice(_CAPTCHA_ALPHABET) for _ in range(4))
    cid = secrets.token_urlsafe(9)
    now = time.time()
    with _lock:
        store = _load_store()
        caps: dict[str, Any] = store.setdefault("captchas", {})
        stale = [k for k, v in caps.items() if float((v or {}).get("exp") or 0) < now]
        for k in stale:
            caps.pop(k, None)
        caps[cid] = {"code": code, "exp": now + _CAPTCHA_TTL}
        _save_store()
    return {"ok": True, "captcha_id": cid, "image_svg": _captcha_svg(code)}


def _consume_captcha(captcha_id: str, answer: str) -> bool:
    cid = str(captcha_id or "").strip()
    got = re.sub(r"\s+", "", str(answer or "")).upper()
    if not cid or len(got) < 4:
        return False
    now = time.time()
    with _lock:
        store = _load_store()
        caps: dict[str, Any] = store.setdefault("captchas", {})
        row = caps.pop(cid, None)
        _save_store()
    if not isinstance(row, dict):
        return False
    if float(row.get("exp") or 0) < now:
        return False
    expect = str(row.get("code") or "").upper()
    return bool(expect) and hmac.compare_digest(expect, got)


def _verify_blocked(phone: str, ip: str) -> dict[str, Any] | None:
    """锁定或 IP 过频时直接拒绝，不再请求阿里云。"""
    ip = (ip or "unknown")[:64]
    now = time.time()
    with _lock:
        store = _load_store()
        verify: dict[str, Any] = store.setdefault("verify", {})
        row = verify.get(phone) if isinstance(verify.get(phone), dict) else {}
        locked = float(row.get("locked_until") or 0)
        if locked > now:
            wait = max(1, int(locked - now))
            return {"ok": False, "message": f"验证失败次数过多，请 {wait // 60} 分 {wait % 60} 秒后再试"}
        ip_map = verify.get("_ip") if isinstance(verify.get("_ip"), dict) else {}
        ip_hits = [float(t) for t in (ip_map.get(ip) or []) if isinstance(t, (int, float))]
        ip_hits = [t for t in ip_hits if now - t < 60]
        if len(ip_hits) >= _IP_VERIFY_PER_MIN:
            _log.warning("verify_ip_rate ip=%s", ip)
            return {"ok": False, "message": "验证过于频繁，请 1 分钟后再试"}
        ip_hits.append(now)
        ip_map[ip] = ip_hits[-30:]
        verify["_ip"] = ip_map
        _save_store()
    return None


def _note_verify_fail(phone: str, ip: str) -> None:
    now = time.time()
    with _lock:
        store = _load_store()
        verify: dict[str, Any] = store.setdefault("verify", {})
        row = verify.get(phone) if isinstance(verify.get(phone), dict) else {}
        fails = int(row.get("fails") or 0) + 1
        locked_until = float(row.get("locked_until") or 0)
        if fails >= _VERIFY_FAIL_MAX:
            locked_until = now + _VERIFY_LOCK_SEC
            fails = 0
            _log.warning("verify_locked phone=%s ip=%s", mask_phone(phone), (ip or "")[:64])
        else:
            _log.warning("verify_fail phone=%s ip=%s fails=%s", mask_phone(phone), (ip or "")[:64], fails)
        verify[phone] = {"fails": fails, "locked_until": locked_until}
        _save_store()


def _note_verify_ok(phone: str) -> None:
    with _lock:
        store = _load_store()
        verify: dict[str, Any] = store.setdefault("verify", {})
        if phone in verify:
            verify.pop(phone, None)
            _save_store()


def reserve_usage(phone: str, kind: str) -> dict[str, Any] | None:
    """生成路书 / 对话改路的每日额度。超限返回错误，不调用模型。"""
    limit = _PLAN_DAILY if kind == "plan" else _CHAT_DAILY
    label = "生成路书" if kind == "plan" else "对话改路"
    today = _today_key()
    with _lock:
        store = _load_store()
        usage: dict[str, Any] = store.setdefault("usage", {})
        row = usage.get(phone) if isinstance(usage.get(phone), dict) else {}
        if str(row.get("day") or "") != today:
            row = {"day": today, "plan": 0, "chat": 0}
        used = int(row.get(kind) or 0)
        if used >= limit:
            _log.warning("usage_cap phone=%s kind=%s", mask_phone(phone), kind)
            return {"ok": False, "message": f"今日{label}次数已用完（每天最多 {limit} 次）"}
        row[kind] = used + 1
        row["day"] = today
        usage[phone] = row
        _save_store()
    return None


def rollback_usage(phone: str, kind: str) -> None:
    today = _today_key()
    with _lock:
        store = _load_store()
        usage: dict[str, Any] = store.setdefault("usage", {})
        row = usage.get(phone)
        if not isinstance(row, dict) or str(row.get("day") or "") != today:
            return
        row[kind] = max(0, int(row.get(kind) or 0) - 1)
        usage[phone] = row
        _save_store()


def inflight_enter(phone: str, kind: str, limit: int) -> bool:
    with _inflight_guard:
        bucket = _inflight.setdefault(kind, {})
        n = int(bucket.get(phone) or 0)
        if n >= limit:
            return False
        bucket[phone] = n + 1
        return True


def inflight_leave(phone: str, kind: str) -> None:
    with _inflight_guard:
        bucket = _inflight.setdefault(kind, {})
        n = int(bucket.get(phone) or 0) - 1
        if n <= 0:
            bucket.pop(phone, None)
        else:
            bucket[phone] = n


def _client():
    from alibabacloud_dypnsapi20170525.client import Client as Dypnsapi20170525Client
    from alibabacloud_tea_openapi import models as open_api_models

    config = open_api_models.Config(
        access_key_id=_cfg("ALIBABA_CLOUD_ACCESS_KEY_ID"),
        access_key_secret=_cfg("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
    )
    config.endpoint = "dypnsapi.aliyuncs.com"
    return Dypnsapi20170525Client(config)


def send_verify_code(phone: str, ip: str = "", captcha_id: str = "", captcha_code: str = "") -> dict[str, Any]:
    if not pnvs_configured():
        return {"ok": False, "message": "短信认证未配置（AccessKey 或 sign/template）"}
    if not _consume_captcha(captcha_id, captcha_code):
        return {"ok": False, "message": "图形验证码错误或已过期，请刷新后重试", "captcha_invalid": True}

    blocked = _reserve_send(phone, ip)
    if blocked:
        return blocked

    from alibabacloud_dypnsapi20170525 import models as m
    from alibabacloud_tea_util import models as util_models

    template_param = json.dumps({"code": "##code##", "min": "5"}, separators=(",", ":"))
    try:
        req = m.SendSmsVerifyCodeRequest(
            phone_number=phone,
            sign_name=_cfg("PNVS_SMS_SIGN_NAME"),
            template_code=_cfg("PNVS_SMS_TEMPLATE_CODE"),
            template_param=template_param,
            country_code="86",
            code_type=1,
            return_verify_code=False,
            duplicate_policy=1,
            interval=_SEND_INTERVAL_SEC,
        )
        runtime = util_models.RuntimeOptions()
        resp = _client().send_sms_verify_code_with_options(req, runtime)
        body = resp.body.to_map() if resp.body else {}
    except Exception as e:
        _rollback_send(phone, ip)
        return {"ok": False, "message": str(e)}

    code = str(body.get("Code") or body.get("code") or "")
    success = body.get("Success") if "Success" in body else body.get("success")
    if success is False or (code and code.upper() not in ("OK", "SUCCESS")):
        _rollback_send(phone, ip)
        msg = body.get("Message") or body.get("message") or "发送失败"
        return {"ok": False, "message": str(msg)}

    model = body.get("Model") or body.get("model") or {}
    out_id = ""
    if isinstance(model, dict):
        out_id = str(model.get("OutId") or model.get("out_id") or "")
    if out_id:
        _set_out_id(phone, out_id)

    quota = _send_quota(phone)
    return {
        "ok": True,
        "message": "验证码已发送",
        "phone_masked": mask_phone(phone),
        "retry_after": _SEND_INTERVAL_SEC,
        "remaining": int(quota.get("remaining") or 0),
    }


def check_verify_code(phone: str, code: str, ip: str = "") -> dict[str, Any]:
    if not pnvs_configured():
        return {"ok": False, "message": "短信认证未配置"}
    code = re.sub(r"\D", "", str(code or ""))[:8]
    if len(code) < 4:
        return {"ok": False, "message": "验证码格式不正确"}
    blocked = _verify_blocked(phone, ip)
    if blocked:
        return blocked
    from alibabacloud_dypnsapi20170525 import models as m
    from alibabacloud_tea_util import models as util_models

    req = m.CheckSmsVerifyCodeRequest(
        phone_number=phone,
        verify_code=code,
        country_code="86",
        case_auth_policy=1,
    )
    out_id = _get_out_id(phone)
    if out_id:
        req.out_id = out_id
    runtime = util_models.RuntimeOptions()
    try:
        resp = _client().check_sms_verify_code_with_options(req, runtime)
        body = resp.body.to_map() if resp.body else {}
    except Exception as e:
        _note_verify_fail(phone, ip)
        return {"ok": False, "message": str(e)}
    model = body.get("Model") or body.get("model") or {}
    verify_result = ""
    if isinstance(model, dict):
        verify_result = str(model.get("VerifyResult") or model.get("verify_result") or "")
    # 仅认 VerifyResult=PASS；接口 Code=OK 只表示调用成功
    if verify_result.upper() == "PASS":
        _note_verify_ok(phone)
        token = create_session(phone)
        return {"ok": True, "phone": phone, "token": token}
    _note_verify_fail(phone, ip)
    msg = body.get("Message") or body.get("message") or "验证码错误或已过期"
    if verify_result:
        msg = "验证码错误或已过期"
    return {"ok": False, "message": str(msg)}
