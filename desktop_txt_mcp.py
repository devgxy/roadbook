from pathlib import Path
from mcp.server.fastmcp import FastMCP

# 创建 MCP Server
mcp = FastMCP("桌面 TXT 文件统计器")


@mcp.tool()
def count_desktop_txt_files() -> int:
    """统计桌面上 .txt 文件的数量"""
    desktop_path = Path.home() / "Desktop"
    txt_files = list(desktop_path.glob("*.txt"))
    return len(txt_files)


@mcp.tool()
def list_desktop_txt_files() -> str:
    """获取桌面上所有 .txt 文件的列表"""
    desktop_path = Path.home() / "Desktop"
    txt_files = list(desktop_path.glob("*.txt"))

    if not txt_files:
        return "桌面上没有找到 .txt 文件。"

    file_list = "\n".join([f"- {file.name}" for file in txt_files])
    return f"在桌面上找到 {len(txt_files)} 个 .txt 文件：\n{file_list}"


if __name__ == "__main__":
    mcp.run()
