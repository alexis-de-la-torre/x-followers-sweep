#!/bin/bash
set -e

SERVICE_PORT="${SERVICE_PORT:-8020}"
SCREENSHOT_DIR="${SCREENSHOT_DIR:-/screenshots}"

echo "=============================================="
echo " X Followers Sweep — Agent"
echo " Model: ${JUDGE_MODEL:-deepseek/deepseek-v4-flash}"
if [ -n "${X_API_ADAPTER_URL:-}" ]; then
  echo " X reads: ${X_API_ADAPTER_URL}"
  echo " X writes: ${X_API_ADAPTER_URL}"
else
  echo " X API adapter: not configured"
fi
echo "=============================================="
echo ""

mkdir -p "$SCREENSHOT_DIR"

export HOST="0.0.0.0"
export PORT="$SERVICE_PORT"
export SCREENSHOT_DIR="$SCREENSHOT_DIR"

cd /app
exec python3 -m uvicorn service:app --host 0.0.0.0 --port "$SERVICE_PORT"
