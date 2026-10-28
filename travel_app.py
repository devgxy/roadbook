"""出行路书产品页：Starlette + SSE 边算边画。"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from dotenv import load_dotenv
from jinja2 import Environment, FileSystemLoader, select_autoescape
from urllib.parse import quote

from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.staticfiles import StaticFiles

from mcp_client import warmup_servers
from rail_hsr import fetch_hsr_trains
from auth_pnvs import (
    check_verify_code,
    inflight_enter,
    inflight_leave,
    issue_captcha,
    mask_phone,
    normalize_phone,
    pnvs_configured,
    reserve_usage,
    resolve_session,
    revoke_session,
    send_verify_code,
)
from insights import (
    add_event,
    add_feedback,
    admin_configured,
    admin_password_ok,
    admin_token_ok,
    export_rows,
    make_admin_token,
    summary as insights_summary,
)
from share_trips import create_share, load_share
from query_guard import check_trip_query
from trip_planner import apply_chat_edit_async, apply_via_reorder_async, image_tones, plan_trip_async

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=True)

for key in (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
):
    os.environ.pop(key, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost,0.0.0.0"
os.environ["no_proxy"] = "127.0.0.1,localhost,0.0.0.0"

_jinja = Environment(
    loader=FileSystemLoader(str(ROOT / "templates")),
    autoescape=select_autoescape(["html", "xml"]),
)


def _as_int(raw: Any, default: int | None = None) -> int | None:
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _plan_params(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "query": str(body.get("query") or ""),
        "origin": str(body.get("origin") or ""),
        "destination": str(body.get("destination") or ""),
        "days": _as_int(body.get("days")),
        "pace": str(body.get("pace") or "balanced"),
        "theme": str(body.get("theme") or "landmark"),
        "budget_level": str(body.get("budget_level") or "comfort"),
        "highway": str(body.get("highway") or "express"),
        "budget_min": _as_int(body.get("budget_min")),
        "budget_max": _as_int(body.get("budget_max")),
        "pax": _as_int(body.get("pax"), 2) or 2,
        "energy_type": str(body.get("energy_type") or "oil"),
        "travel_mode": str(body.get("travel_mode") or "drive"),
        "start_date": str(body.get("start_date") or ""),
        "only_region": str(body.get("only_region") or ""),
    }


def _safe_next_path(raw: str | None) -> str:
    path = str(raw or "").strip()
    if not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


async def login_page(request: Request) -> Response:
    if _session_phone(request):
        return RedirectResponse(_safe_next_path(request.query_params.get("next")), status_code=302)
    html = _jinja.get_template("login.html").render(
        sms_configured=pnvs_configured(),
        next_path=_safe_next_path(request.query_params.get("next")),
    )
    # 禁止 bfcache：否则登录成功后点「返回」会还原未登录态的登录页
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


def _share_title(trip: dict[str, Any] | None) -> str:
    if not isinstance(trip, dict):
        return "分享路书"
    origin = str(trip.get("origin") or "").strip() or "出发"
    dest = str(trip.get("destination") or "").strip() or "抵达"
    days = trip.get("days")
    start = str(trip.get("start_date") or "").strip()
    bits = [f"{origin} → {dest}"]
    if days:
        bits.append(f"{days} 天")
    if start:
        bits.append(start)
    return " · ".join(bits)


async def homepage(_: Request) -> HTMLResponse:
    html = _jinja.get_template("index.html").render(
        share_mode=False, share_id="", share_title=""
    )
    return HTMLResponse(html)


async def share_page(request: Request) -> Response:
    share_id = str(request.path_params.get("share_id") or "")
    data = load_share(share_id)
    if not data:
        return HTMLResponse("<h1>分享不存在或已过期</h1><p><a href='/'>回首页</a></p>", status_code=404)
    trip = data.get("trip") if isinstance(data, dict) else None
    html = _jinja.get_template("index.html").render(
        share_mode=True,
        share_id=share_id,
        share_title=_share_title(trip if isinstance(trip, dict) else None),
    )
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-store"},
    )


async def api_share_create(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    trip = body.get("trip") if isinstance(body, dict) else None
    if not isinstance(trip, dict):
        return JSONResponse({"ok": False, "message": "缺少路书"}, status_code=400)
    phone = _session_phone(request) or ""
    result = create_share(trip, owner_phone=phone)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


async def api_share_get(request: Request) -> JSONResponse:
    share_id = str(request.path_params.get("share_id") or "")
    data = load_share(share_id)
    if not data:
        return JSONResponse({"ok": False, "message": "分享不存在或已过期"}, status_code=404)
    return JSONResponse({"ok": True, **data})


_public_hits: dict[str, deque[float]] = {}
_public_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    real = (request.headers.get("x-real-ip") or "").strip()
    if real:
        return real[:64]
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "")
    return proto.split(",")[0].strip().lower() == "https"


def _allow_public(ip: str, bucket: str, limit: int, window: float) -> bool:
    now = time.time()
    key = f"{bucket}:{ip}"
    with _public_lock:
        dq = _public_hits.setdefault(key, deque())
        while dq and now - dq[0] > window:
            dq.popleft()
        if len(dq) >= limit:
            return False
        dq.append(now)
        return True


def _csrf_token(request: Request) -> str:
    tok = request.cookies.get("rb_csrf") or ""
    if len(tok) < 16:
        tok = secrets.token_urlsafe(24)
    return tok


def _stamp_csrf(response: Response, request: Request, token: str) -> Response:
    if request.cookies.get("rb_csrf") != token:
        response.set_cookie(
            "rb_csrf",
            token,
            httponly=False,
            samesite="lax",
            secure=_https(request),
            path="/",
            max_age=30 * 86400,
        )
    return response


def _public_bucket(path: str, method: str) -> tuple[str, int] | None:
    if path.startswith("/s/") or (path.startswith("/api/share/") and method == "GET"):
        return ("share", 40)
    if path.startswith("/api/qrcode"):
        return ("qr", 20)
    if path.startswith("/api/img"):
        return ("img", 80)
    if path == "/api/image-tones":
        return ("tones", 30)
    if path.startswith("/api/auth/captcha"):
        return ("captcha", 30)
    if path == "/api/feedback":
        return ("feedback", 8)
    if path == "/api/events":
        return ("events", 40)
    if path == "/api/admin/login":
        return ("admin", 8)
    return None


class RequireLoginMiddleware(BaseHTTPMiddleware):
    """未登录仅可访问登录页、分享页、静态资源与认证/健康 API。"""

    @staticmethod
    def _is_public(path: str) -> bool:
        if path in ("/login", "/admin", "/api/health", "/api/qrcode"):
            return True
        if path.startswith("/static/"):
            return True
        if path.startswith("/api/auth/") or path in ("/api/feedback", "/api/events", "/api/admin/login", "/api/admin/summary", "/api/admin/export"):
            return True
        if path.startswith("/s/"):
            return True
        if path.startswith("/api/share/") and path != "/api/share":
            return True
        if path.startswith("/api/img"):
            return True
        if path == "/api/image-tones":
            return True
        return False

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        path = request.url.path
        method = request.method.upper()
        ip = _client_ip(request)
        token = _csrf_token(request)
        bucket = _public_bucket(path, method)
        if bucket and not _allow_public(ip, bucket[0], bucket[1], 60):
            resp: Response = JSONResponse(
                {"ok": False, "message": "请求过于频繁，请稍后再试"},
                status_code=429,
            )
            return _stamp_csrf(resp, request, token)
        if method in ("POST", "PUT", "PATCH", "DELETE") and path.startswith("/api/"):
            if path.startswith("/api/auth/") and not (request.headers.get("user-agent") or "").strip():
                return JSONResponse({"ok": False, "message": "拒绝空客户端"}, status_code=403)
            cookie = request.cookies.get("rb_csrf") or ""
            header = request.headers.get("x-csrf-token") or ""
            if not cookie or not header or not hmac.compare_digest(cookie, header):
                resp = JSONResponse({"ok": False, "message": "页面已过期，请刷新后重试"}, status_code=403)
                return _stamp_csrf(resp, request, token)
        if not self._is_public(path) and not _session_phone(request):
            if path.startswith("/api/"):
                resp = JSONResponse(
                    {"ok": False, "message": "请先登录", "login_required": True},
                    status_code=401,
                )
                return _stamp_csrf(resp, request, token)
            resp = RedirectResponse(f"/login?next={quote(path)}", status_code=302)
            return _stamp_csrf(resp, request, token)
        response = await call_next(request)
        return _stamp_csrf(response, request, token)


def _sse_error(message: str) -> StreamingResponse:
    async def gen() -> AsyncIterator[bytes]:
        payload = json.dumps({"stage": "error", "data": {"message": message}}, ensure_ascii=False)
        yield f"data: {payload}\n\n".encode("utf-8")
        yield b"event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def _begin_model(request: Request, kind: str) -> tuple[str | None, str | None]:
    phone = _session_phone(request)
    if not phone:
        return None, "请先登录"
    limit = 1 if kind == "plan" else 2
    if not inflight_enter(phone, kind, limit):
        return None, "已有任务进行中，请稍候再试"
    err = reserve_usage(phone, kind)
    if err:
        inflight_leave(phone, kind)
        return None, str(err.get("message") or "今日次数已用完")
    return phone, None


async def plan_stream(request: Request) -> StreamingResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        async def bad_json() -> AsyncIterator[bytes]:
            payload = json.dumps({"stage": "error", "data": {"message": "无效的请求体"}}, ensure_ascii=False)
            yield f"data: {payload}\n\n".encode("utf-8")
            yield b"event: done\ndata: {}\n\n"
        return StreamingResponse(bad_json(), media_type="text/event-stream")
    params = _plan_params(body)
    rejected = check_trip_query(params["query"], params["origin"], params["destination"])
    if rejected:
        return _sse_error(rejected)
    phone, deny = _begin_model(request, "plan")
    if deny or not phone:
        return _sse_error(deny or "请先登录")

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    async def stage(name: str, payload: dict[str, Any]) -> None:
        await queue.put({"stage": name, "data": payload})

    def progress(msg: str) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait, {"stage": "progress", "data": {"message": msg}}
        )

    async def runner() -> None:
        try:
            await plan_trip_async(
                **params,
                progress=progress,
                stage=stage,
                with_photos=True,
            )
        except Exception as e:
            await queue.put({"stage": "error", "data": {"message": str(e)}})
        finally:
            await queue.put(None)

    async def event_gen() -> AsyncIterator[bytes]:
        task = asyncio.create_task(runner())
        try:
            while True:
                if await request.is_disconnected():
                    task.cancel()
                    break
                item = await queue.get()
                if item is None:
                    yield b"event: done\ndata: {}\n\n"
                    break
                payload = json.dumps(item, ensure_ascii=False)
                yield f"data: {payload}\n\n".encode("utf-8")
        finally:
            inflight_leave(phone, "plan")
            if not task.done():
                task.cancel()
                try:
                    await task
                except Exception:
                    pass

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def plan_json(request: Request) -> JSONResponse:
    """一次性 JSON 返回，方便未来小程序 wx.request 对接。"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "message": "无效的请求体"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "message": "无效的请求体"}, status_code=400)
    if body.get("days") not in (None, "") and _as_int(body.get("days")) is None:
        return JSONResponse({"ok": False, "message": "天数无效"}, status_code=400)
    params = _plan_params(body)
    rejected = check_trip_query(params["query"], params["origin"], params["destination"])
    if rejected:
        return JSONResponse({"ok": False, "message": rejected}, status_code=400)
    phone, deny = _begin_model(request, "plan")
    if deny or not phone:
        return JSONResponse({"ok": False, "message": deny or "请先登录"}, status_code=429)
    try:
        trip = await plan_trip_async(**params, with_photos=True)
        return JSONResponse({"ok": True, "trip": trip})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=400)
    finally:
        inflight_leave(phone, "plan")


async def health(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


async def rail_hsr(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    origin = str((body or {}).get("origin") or "").strip()
    dest = str((body or {}).get("destination") or "").strip()
    if not origin or not dest:
        return JSONResponse({"ok": False, "message": "需要 origin 与 destination"}, status_code=400)
    pax = _as_int((body or {}).get("pax"), 2) or 2
    travel_date = (body or {}).get("travel_date")
    try:
        data = await fetch_hsr_trains(
            origin, dest, travel_date=str(travel_date) if travel_date else None, pax=pax
        )
        return JSONResponse({"ok": True, "hsr": data})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=400)


_IMG_HOST_SUFFIXES = ("amap.com", "autonavi.com", "gaode.com", "alicdn.com")


def _img_host_ok(host: str) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in _IMG_HOST_SUFFIXES)


def _sniff_image_type(content: bytes, header: str) -> str | None:
    if header.startswith("image/"):
        return header.split(";", 1)[0].strip()
    if content.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG"):
        return "image/png"
    if content.startswith(b"GIF8"):
        return "image/gif"
    if content.startswith(b"RIFF") and b"WEBP" in content[:16]:
        return "image/webp"
    return None


async def poster_image(request: Request) -> Response:
    """把高德配图转成同源地址，海报画布才能铺实拍并导出。"""
    from urllib.parse import urlparse

    import httpx

    raw = str(request.query_params.get("u") or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not _img_host_ok(parsed.hostname or ""):
        return Response(status_code=400)
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True, trust_env=False) as client:
            resp = await client.get(raw, headers={"Referer": "https://www.amap.com/"})
    except Exception:
        return Response(status_code=502)
    final = urlparse(str(resp.url))
    if final.scheme != "https" or not _img_host_ok(final.hostname or ""):
        return Response(status_code=502)
    if resp.status_code != 200 or not resp.content or len(resp.content) > 3_000_000:
        return Response(status_code=502)
    media = _sniff_image_type(resp.content, resp.headers.get("content-type", ""))
    if not media:
        return Response(status_code=502)
    return Response(resp.content, media_type=media, headers={"Cache-Control": "public, max-age=86400"})


async def poster_qrcode(request: Request) -> Response:
    """海报二维码：扫码读出行程摘要，纯文本离线可扫，不依赖外网。"""
    import io

    import segno

    data = str(request.query_params.get("data") or "").strip()
    if not data:
        return Response(status_code=400)
    data = data[:600]
    try:
        qr = segno.make(data, error="m")
    except Exception:
        return Response(status_code=400)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=8, border=2, dark="#1c1916", light="#eadfcc")
    return Response(
        buf.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


async def tones(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({}, status_code=400)
    urls = body.get("urls") if isinstance(body, dict) else None
    if not isinstance(urls, list):
        return JSONResponse({}, status_code=400)
    return JSONResponse(await image_tones([str(u) for u in urls]))


async def via_reorder(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "message": "无效的请求体"}, status_code=400)
    trip = body.get("trip") if isinstance(body, dict) else None
    via = body.get("via_cities") if isinstance(body, dict) else None
    if not isinstance(trip, dict) or not isinstance(via, list):
        return JSONResponse({"ok": False, "message": "缺少路书或途经顺序"}, status_code=400)
    phone, deny = _begin_model(request, "chat")
    if deny or not phone:
        return JSONResponse({"ok": False, "message": deny or "请先登录"}, status_code=429)
    try:
        res = await apply_via_reorder_async(trip, [str(x) for x in via])
        return JSONResponse({"ok": True, **res})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=400)
    finally:
        inflight_leave(phone, "chat")


def _session_phone(request: Request) -> str | None:
    token = request.cookies.get("rb_session") or ""
    return resolve_session(token)


async def auth_sms_send(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    phone = normalize_phone(str((body or {}).get("phone") or ""))
    if not phone:
        return JSONResponse({"ok": False, "message": "请输入大陆 11 位手机号"}, status_code=400)
    captcha_id = str((body or {}).get("captcha_id") or "")
    captcha_code = str((body or {}).get("captcha_code") or "")
    ip = _client_ip(request)
    try:
        result = await asyncio.to_thread(send_verify_code, phone, ip, captcha_id, captcha_code)
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=502)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


async def auth_sms_verify(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    phone = normalize_phone(str((body or {}).get("phone") or ""))
    code = str((body or {}).get("code") or "")
    if not phone:
        return JSONResponse({"ok": False, "message": "手机号无效"}, status_code=400)
    try:
        result = await asyncio.to_thread(check_verify_code, phone, code, _client_ip(request))
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=502)
    if not result.get("ok"):
        return JSONResponse(result, status_code=400)
    resp = JSONResponse(
        {
            "ok": True,
            "phone_masked": mask_phone(phone),
            "message": "登录成功",
        }
    )
    resp.set_cookie(
        "rb_session",
        result["token"],
        httponly=True,
        samesite="lax",
        secure=_https(request),
        max_age=30 * 86400,
        path="/",
    )
    return resp


async def auth_me(request: Request) -> JSONResponse:
    phone = _session_phone(request)
    if not phone:
        return JSONResponse({"ok": True, "logged_in": False, "phone_masked": "", "phone_tail": ""})
    return JSONResponse({
        "ok": True,
        "logged_in": True,
        "phone_masked": mask_phone(phone),
        "phone_tail": phone[-2:] if len(phone) >= 2 else "",
    })


async def auth_logout(request: Request) -> JSONResponse:
    token = request.cookies.get("rb_session") or ""
    revoke_session(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("rb_session", path="/")
    return resp


def _admin_ok(request: Request) -> bool:
    return admin_token_ok(request.cookies.get("rb_admin") or "")


async def admin_page(_: Request) -> HTMLResponse:
    html = _jinja.get_template("admin.html").render(configured=admin_configured())
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


async def admin_login(request: Request) -> JSONResponse:
    if not admin_configured():
        return JSONResponse({"ok": False, "message": "未配置后台口令"}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not admin_password_ok(str((body or {}).get("password") or "")):
        return JSONResponse({"ok": False, "message": "口令不正确"}, status_code=401)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        "rb_admin",
        make_admin_token(),
        httponly=True,
        samesite="lax",
        secure=_https(request),
        path="/",
        max_age=7 * 86400,
    )
    return resp


async def admin_summary(request: Request) -> JSONResponse:
    if not _admin_ok(request):
        return JSONResponse({"ok": False, "message": "请先登录后台"}, status_code=401)
    return JSONResponse(insights_summary())


async def admin_export(request: Request) -> Response:
    if not _admin_ok(request):
        return JSONResponse({"ok": False, "message": "请先登录后台"}, status_code=401)
    kind = "events" if request.query_params.get("kind") == "events" else "feedback"
    raw = json.dumps(export_rows(kind), ensure_ascii=False, indent=2)
    return Response(
        raw,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{kind}.json"'},
    )


async def feedback_create(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    phone = _session_phone(request)
    masked = mask_phone(phone) if phone else ""
    result = add_feedback(
        str((body or {}).get("text") or ""),
        str((body or {}).get("category") or ""),
        masked,
        _client_ip(request),
    )
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


async def events_create(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    phone = _session_phone(request)
    masked = mask_phone(phone) if phone else ""
    props = (body or {}).get("props") if isinstance(body, dict) else None
    result = add_event(str((body or {}).get("name") or ""), props if isinstance(props, dict) else {}, masked, _client_ip(request))
    return JSONResponse(result, status_code=200 if result.get("ok") else 400)


async def auth_captcha(_: Request) -> JSONResponse:
    return JSONResponse(issue_captcha())


async def auth_status(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "sms_configured": pnvs_configured()})


async def chat_edit(request: Request) -> JSONResponse:
    """无状态对话微调接口：接收 {trip, message}，返回 {ok, trip, reply, changes, focus_day}。"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "message": "无效的请求体"}, status_code=400)
    trip = body.get("trip") if isinstance(body, dict) else None
    message = str((body or {}).get("message") or "").strip()
    if not isinstance(trip, dict) or not message:
        return JSONResponse({"ok": False, "message": "缺少当前路书或修改指令"}, status_code=400)
    phone, deny = _begin_model(request, "chat")
    if deny or not phone:
        return JSONResponse({"ok": False, "message": deny or "请先登录"}, status_code=429)
    try:
        res = await apply_chat_edit_async(trip, message)
        return JSONResponse({"ok": True, **res})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=400)
    finally:
        inflight_leave(phone, "chat")


routes = [
    Route("/login", login_page),
    Route("/admin", admin_page),
    Route("/api/admin/login", admin_login, methods=["POST"]),
    Route("/api/admin/summary", admin_summary),
    Route("/api/admin/export", admin_export),
    Route("/api/feedback", feedback_create, methods=["POST"]),
    Route("/api/events", events_create, methods=["POST"]),
    Route("/", homepage),
    Route("/s/{share_id}", share_page),
    Route("/api/share", api_share_create, methods=["POST"]),
    Route("/api/share/{share_id}", api_share_get),
    Route("/api/plan", plan_stream, methods=["POST"]),
    Route("/api/plan/json", plan_json, methods=["POST"]),
    Route("/api/chat-edit", chat_edit, methods=["POST"]),
    Route("/api/via-reorder", via_reorder, methods=["POST"]),
    Route("/api/image-tones", tones, methods=["POST"]),
    Route("/api/img", poster_image),
    Route("/api/qrcode", poster_qrcode),
    Route("/api/health", health),
    Route("/api/rail-hsr", rail_hsr, methods=["POST"]),
    Route("/api/auth/status", auth_status),
    Route("/api/auth/me", auth_me),
    Route("/api/auth/logout", auth_logout, methods=["POST"]),
    Route("/api/auth/captcha", auth_captcha),
    Route("/api/auth/sms/send", auth_sms_send, methods=["POST"]),
    Route("/api/auth/sms/verify", auth_sms_verify, methods=["POST"]),
]

static_dir = ROOT / "static"
static_dir.mkdir(exist_ok=True)

async def _startup() -> None:
    asyncio.create_task(warmup_servers())


app = Starlette(routes=routes, on_startup=[_startup])
app.add_middleware(RequireLoginMiddleware)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


if __name__ == "__main__":
    uvicorn.run(
        "travel_app:app",
        host="127.0.0.1",
        port=7861,
        reload=False,
        log_level="info",
    )
