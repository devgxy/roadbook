"""MCP Client：统一配置多个 MCP Server，并支持按服务名调用工具。

提供能力：
1. get_mcp_servers_config() —— 给 Agent（qwen_agent）挂载全部 MCP
2. call_tool() / list_tools() —— 直连自写 desktop-txt
3. call_server_tool() / open_server_session() —— 按服务名调用（出行规划复用会话）
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=True)

MCP_PYTHON = str(ROOT / ".venv" / "bin" / "python")
MCP_SCRIPT = str(ROOT / "desktop_txt_mcp.py")
DESKTOP_SERVER_NAME = "desktop-txt"


def get_mcp_servers_config() -> dict:
    """返回 qwen_agent function_list 所需的 mcpServers 配置（三服务合一）。

    缺少 API Key 的远程 MCP 会跳过注册，避免进程启动即崩溃。
    """
    return {"mcpServers": _build_servers()}


def _build_servers() -> dict[str, dict]:
    servers: dict[str, dict] = {
        DESKTOP_SERVER_NAME: {
            "command": MCP_PYTHON,
            "args": [MCP_SCRIPT],
        },
    }

    amap_key = os.getenv("AMAP_MAPS_API_KEY", "").strip()
    if amap_key:
        servers["amap-maps"] = {
            "command": "npx",
            "args": ["-y", "@amap/amap-maps-mcp-server"],
            "env": {"AMAP_MAPS_API_KEY": amap_key},
        }
    else:
        print("警告: 未设置 AMAP_MAPS_API_KEY，跳过高德 MCP")

    tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
    if tavily_key:
        servers["tavily-mcp"] = {
            "command": "npx",
            "args": ["-y", "tavily-mcp@0.1.4"],
            "env": {"TAVILY_API_KEY": tavily_key},
        }
    else:
        print("警告: 未设置 TAVILY_API_KEY，跳过 Tavily MCP")

    servers["12306-mcp"] = {
        "command": "npx",
        "args": ["-y", "12306-mcp"],
    }

    return servers


def has_server(server_name: str) -> bool:
    return server_name in _build_servers()


def _server_params_for(server_name: str) -> StdioServerParameters:
    servers = _build_servers()
    if server_name not in servers:
        raise RuntimeError(f"MCP 服务未配置或缺少 API Key: {server_name}")
    cfg = servers[server_name]
    return StdioServerParameters(
        command=cfg["command"],
        args=cfg.get("args") or [],
        env={**os.environ, **(cfg.get("env") or {})},
    )


def _server_params() -> StdioServerParameters:
    return _server_params_for(DESKTOP_SERVER_NAME)


def _result_to_text(result: Any) -> str:
    texts = []
    for item in getattr(result, "content", []) or []:
        if hasattr(item, "text"):
            texts.append(item.text)
    return "\n".join(texts) if texts else str(result)


class McpServerSession:
    """同一轮规划中复用的 MCP 会话（带高德 QPS 保护）。"""

    def __init__(self, session: ClientSession, min_interval: float = 0.0):
        self._session = session
        self._min_interval = min_interval
        self._lock = asyncio.Lock()
        self._last_ts = 0.0

    async def call_tool(self, tool_name: str, arguments: dict | None = None) -> str:
        for attempt in range(3):
            async with self._lock:
                if self._min_interval > 0:
                    wait = self._min_interval - (time.monotonic() - self._last_ts)
                    if wait > 0:
                        await asyncio.sleep(wait)
                    self._last_ts = time.monotonic()
                result = await self._session.call_tool(tool_name, arguments=arguments or {})
            text = _result_to_text(result)
            if "CUQPS_HAS_EXCEEDED_THE_LIMIT" in text and attempt < 2:
                await asyncio.sleep(0.45 * (attempt + 1))
                continue
            return text
        return text

    async def list_tools(self) -> list[str]:
        tools = await self._session.list_tools()
        return [t.name for t in tools.tools]


_POOL: dict[str, tuple[McpServerSession, asyncio.Task, asyncio.Event]] = {}
_POOL_LOCKS: dict[str, asyncio.Lock] = {}
SPAWN_TIMEOUT_SEC = 30.0


def _pool_lock(server_name: str) -> asyncio.Lock:
    # 按服务分锁：一个子进程启动卡死不能拖住其他 MCP
    lock = _POOL_LOCKS.get(server_name)
    if lock is None:
        lock = _POOL_LOCKS[server_name] = asyncio.Lock()
    return lock


async def _spawn_persistent(server_name: str) -> McpServerSession:
    params = _server_params_for(server_name)
    ready: asyncio.Future[McpServerSession] = asyncio.get_running_loop().create_future()
    stop_event = asyncio.Event()

    async def worker() -> None:
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            interval = 0.36 if server_name == "amap-maps" else 0.0
            ready.set_result(McpServerSession(session, min_interval=interval))
            await stop_event.wait()
        except Exception as e:
            if not ready.done():
                ready.set_exception(e)
        finally:
            try:
                await stack.aclose()
            except Exception:
                pass
            _POOL.pop(server_name, None)

    task = asyncio.create_task(worker())
    try:
        mcp = await asyncio.wait_for(asyncio.shield(ready), timeout=SPAWN_TIMEOUT_SEC)
    except BaseException:
        stop_event.set()
        task.cancel()
        raise
    _POOL[server_name] = (mcp, task, stop_event)
    return mcp


@asynccontextmanager
async def open_server_session(server_name: str) -> AsyncIterator[McpServerSession]:
    """复用常驻 MCP 子进程会话，避免每次请求重新 npx 冷启动。"""
    async with _pool_lock(server_name):
        entry = _POOL.get(server_name)
        if entry is None or entry[1].done():
            mcp = await _spawn_persistent(server_name)
        else:
            mcp = entry[0]
    try:
        yield mcp
    except Exception:
        # 会话异常时丢弃，下次重建
        entry = _POOL.pop(server_name, None)
        if entry:
            entry[2].set()
        raise


async def warmup_servers(names: list[str] | None = None) -> None:
    """服务启动时预热高德与 Tavily 子进程。"""
    # 12306 启动时就会请求官网，网络抖动会让进程直接退出，故不预热、用到时再起
    targets = names or [n for n in ("amap-maps", "tavily-mcp") if has_server(n)]
    await asyncio.gather(
        *( _spawn_if_needed(name) for name in targets ),
        return_exceptions=True,
    )


async def _spawn_if_needed(name: str) -> None:
    async with open_server_session(name):
        return


async def call_server_tool_async(
    server_name: str, tool_name: str, arguments: dict | None = None
) -> str:
    """按服务名一次性调用工具。"""
    async with open_server_session(server_name) as mcp:
        return await mcp.call_tool(tool_name, arguments)


def call_server_tool(
    server_name: str, tool_name: str, arguments: dict | None = None
) -> str:
    return asyncio.run(call_server_tool_async(server_name, tool_name, arguments))


async def _call_tool_async(tool_name: str, arguments: dict | None = None) -> Any:
    """通过 stdio 拉起 desktop-txt MCP Server，调用指定工具并返回结果文本。"""
    return await call_server_tool_async(DESKTOP_SERVER_NAME, tool_name, arguments)


def call_tool(tool_name: str, arguments: dict | None = None) -> Any:
    """同步封装：调用 desktop-txt MCP 工具。"""
    return asyncio.run(_call_tool_async(tool_name, arguments))


async def list_tools_async() -> list[str]:
    """列出 desktop-txt MCP Server 暴露的工具名。"""
    async with open_server_session(DESKTOP_SERVER_NAME) as mcp:
        return await mcp.list_tools()


def list_tools() -> list[str]:
    return asyncio.run(list_tools_async())


if __name__ == "__main__":
    print("desktop-txt 可用工具:", list_tools())
    print("数量:", call_tool("count_desktop_txt_files"))
    print(call_tool("list_desktop_txt_files"))
