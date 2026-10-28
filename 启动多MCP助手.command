#!/bin/bash
# 双击本文件即可启动：对话助手(7860) + 出行产品页(7861)
set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  多 MCP 助手 + 出行产品页"
echo "========================================"

if [ ! -d ".venv" ]; then
  echo "错误: 未找到 .venv，请先安装依赖："
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "已根据 .env.example 创建 .env，请填入 API Key 后重新启动。"
    open -e .env
    read -n 1 -s -r -p "按任意键退出..."
    exit 1
  fi
  echo "错误: 缺少 .env，请先配置 API Key。"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# 释放旧端口
for port in 7860 7861; do
  if lsof -ti:$port >/dev/null 2>&1; then
    echo "检测到 $port 端口占用，正在结束旧进程..."
    lsof -ti:$port | xargs kill -9 2>/dev/null || true
  fi
done
sleep 1

# 避免系统代理导致 Gradio 访问 localhost 失败
export NO_PROXY=127.0.0.1,localhost,0.0.0.0
export no_proxy=127.0.0.1,localhost,0.0.0.0
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

echo "对话助手: http://127.0.0.1:7860"
echo "出行产品页: http://127.0.0.1:7861"
echo "关闭本窗口将停止全部服务。"
echo "----------------------------------------"

cleanup() {
  echo ""
  echo "正在停止服务..."
  kill $AGENT_PID $TRAVEL_PID 2>/dev/null || true
  wait $AGENT_PID $TRAVEL_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

.venv/bin/python -u agent.py &
AGENT_PID=$!

.venv/bin/python -u travel_app.py &
TRAVEL_PID=$!

# 优先打开出行产品页
(
  for i in $(seq 1 90); do
    if curl -sf -o /dev/null http://127.0.0.1:7861/; then
      open "http://127.0.0.1:7861"
      exit 0
    fi
    sleep 1
  done
) &

wait $AGENT_PID $TRAVEL_PID
