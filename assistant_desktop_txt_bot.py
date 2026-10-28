"""兼容入口：实际逻辑已拆到 agent.py / mcp_client.py / desktop_txt_mcp.py。"""

from agent import app_gui, app_tui, init_agent_service, test

__all__ = ["init_agent_service", "test", "app_tui", "app_gui"]

if __name__ == "__main__":
    app_gui()
