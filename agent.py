"""Agent：基于 qwen_agent 的多 MCP 助手。

挂载高德地图、Tavily 搜索与自写桌面 TXT 三个 MCP，
通过自然语言完成自驾规划、网页转 Markdown、新闻检索、桌面文件统计。
"""

import os
from pathlib import Path
from typing import Optional

import dashscope
from dotenv import load_dotenv
from qwen_agent.agents import Assistant
from qwen_agent.gui import WebUI

from mcp_client import get_mcp_servers_config

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

dashscope.api_key = os.getenv("DASHSCOPE_API_KEY", "")
dashscope.timeout = 30


def init_agent_service() -> Assistant:
    """初始化助手，挂载全部 MCP Client 配置的工具。"""
    llm_cfg = {
        "model": "qwen-max",
        "timeout": 30,
        "retry_count": 3,
    }
    system = (
        "你是多能力助手。"
        "请根据用户任务选用合适的 MCP 工具完成请求，并用简洁中文回复。"
    )
    tools = [get_mcp_servers_config()]

    try:
        bot = Assistant(
            llm=llm_cfg,
            name="多 MCP 助手",
            description="自驾规划 / 网页与新闻检索 / 桌面 txt 统计",
            system_message=system,
            function_list=tools,
        )
        print("助手初始化成功！")
        return bot
    except Exception as e:
        print(f"助手初始化失败: {str(e)}")
        raise


def test(query: str = "帮我看看桌面上有几个 txt 文件", file: Optional[str] = None):
    """测试模式：跑一轮查询。"""
    try:
        bot = init_agent_service()
        messages = []
        if not file:
            messages.append({"role": "user", "content": query})
        else:
            messages.append({"role": "user", "content": [{"text": query}, {"file": file}]})

        print("正在处理您的请求...")
        for response in bot.run(messages):
            print("bot response:", response)
    except Exception as e:
        print(f"处理请求时出错: {str(e)}")


def app_tui():
    """终端交互模式。"""
    try:
        bot = init_agent_service()
        messages = []
        while True:
            try:
                query = input("user question: ")
                file = input("file url (press enter if no file): ").strip()

                if not query:
                    print("user question cannot be empty！")
                    continue

                if not file:
                    messages.append({"role": "user", "content": query})
                else:
                    messages.append(
                        {"role": "user", "content": [{"text": query}, {"file": file}]}
                    )

                print("正在处理您的请求...")
                response = []
                for response in bot.run(messages):
                    print("bot response:", response)
                messages.extend(response)
            except Exception as e:
                print(f"处理请求时出错: {str(e)}")
                print("请重试或输入新的问题")
    except Exception as e:
        print(f"启动终端模式失败: {str(e)}")


def app_gui():
    """Web 图形界面模式。"""
    try:
        # 避免系统代理导致 Gradio 访问 localhost 失败
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

        print("正在启动 Web 界面...")
        bot = init_agent_service()
        chatbot_config = {
            "prompt.suggestions": [
                "规划从北京到成都的7天自驾游",
                "获取 https://example.com 的内容并转为 Markdown",
                "检索最新的关税新闻并总结",
                "统计桌面上有多少个 txt 文件",
            ]
        }
        print("Web 界面准备就绪，正在启动服务...")
        WebUI(bot, chatbot_config=chatbot_config).run()
    except Exception as e:
        print(f"启动 Web 界面失败: {str(e)}")
        print("请检查网络连接和 API Key 配置")


if __name__ == "__main__":
    # test()       # 测试模式
    # app_tui()    # 终端交互模式
    app_gui()      # 图形界面模式（默认）
