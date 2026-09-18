#!/usr/bin/env bash
# 在自己电脑上跑墙，并用 Cloudflare 临时隧道给朋友一个公网链接（不需要账号和域名）。
# 用法：在项目根目录执行  ./deploy/local-tunnel.sh
# 需要先装 cloudflared：macOS 上 brew install cloudflared
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null; then
  echo "没找到 cloudflared。macOS 上先执行：brew install cloudflared" >&2
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev

PORT="$PORT" node server.js &
SERVER=$!
# 退出时把服务和防休眠一起停掉
trap 'kill $SERVER 2>/dev/null; kill ${AWAKE:-} 2>/dev/null' EXIT

# macOS：隧道开着的时候别让电脑睡着
if command -v caffeinate >/dev/null; then
  caffeinate -dims -w $SERVER &
  AWAKE=$!
fi

sleep 1
echo "墙已在本机 http://localhost:$PORT 启动。下面 cloudflared 打印的 https://….trycloudflare.com 就是发给朋友的地址。"
cloudflared tunnel --url "http://localhost:$PORT"
