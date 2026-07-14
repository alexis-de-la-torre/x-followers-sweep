#!/bin/bash
set -e

CHROME_PORT="${CHROME_PORT:-9222}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/chrome-profile}"
SERVICE_PORT="${SERVICE_PORT:-8020}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
SCREENSHOT_DIR="${SCREENSHOT_DIR:-/screenshots}"

echo "=============================================="
echo " X Cleanup Service"
echo " Model: ${JUDGE_MODEL:-deepseek/deepseek-v4-flash}"
echo "=============================================="
echo " VNC:  localhost:$VNC_PORT  (noVNC on :$NOVNC_PORT)"
echo " API:  localhost:$SERVICE_PORT"
echo ""

mkdir -p "$CHROME_PROFILE_DIR" "$SCREENSHOT_DIR"

# 1. Virtual display
echo "[1] Starting Xvfb..."
Xvfb :99 -screen 0 414x896x24 &
sleep 1

# 2. Window manager
echo "[2] Starting Fluxbox..."
fluxbox &
sleep 1

# 3. VNC server
echo "[3] Starting x11vnc on port $VNC_PORT..."
x11vnc -display :99 -forever -shared -rfbport "$VNC_PORT" -nopw -quiet &
sleep 1

# 4. noVNC web client
echo "[4] Starting noVNC on port $NOVNC_PORT..."
/opt/noVNC/utils/novnc_proxy \
    --vnc "localhost:$VNC_PORT" \
    --listen "$NOVNC_PORT" \
    --web /opt/noVNC \
    > /tmp/novnc.log 2>&1 &
sleep 2
# Verify noVNC is listening
if netstat -tlnp 2>/dev/null | grep -q "$NOVNC_PORT" || ss -tlnp 2>/dev/null | grep -q "$NOVNC_PORT"; then
    echo "  noVNC ready on port $NOVNC_PORT"
else
    echo "  ⚠️  noVNC may not have started (check /tmp/novnc.log)"
fi

# 5. Cloudflare tunnel
echo "[5] Creating Cloudflare tunnel to noVNC..."
cloudflared tunnel --url "http://localhost:$NOVNC_PORT" \
    > /tmp/cloudflared.log 2>&1 &
CLOUDFLARE_PID=$!
for i in $(seq 1 30); do
    URL=$(grep -oP 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -1)
    if [ -n "$URL" ]; then
        echo "  ✅ Open this URL in your browser:"
        echo "     $URL"
        break
    fi
    sleep 1
done
if [ -z "$URL" ]; then
    echo "  ⚠️  Cloudflare URL not yet available (check /tmp/cloudflared.log)"
fi

# 6. Chrome
echo "[6] Starting Chrome..."
google-chrome-stable \
    --disable-gpu \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --no-first-run \
    --password-store=basic \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --window-size=414,896 \
    https://x.com/login \
    &
CHROME_PID=$!
for i in $(seq 1 30); do
    if curl -s "http://localhost:$CHROME_PORT/json/version" > /dev/null 2>&1; then
        echo "  Chrome ready (PID: $CHROME_PID)"
        break
    fi
    sleep 1
done

# 7. Service
echo "[7] Starting service..."
export HOST="0.0.0.0"
export PORT="$SERVICE_PORT"
export SCREENSHOT_DIR="$SCREENSHOT_DIR"
cd /app
exec python3 -m uvicorn service:app --host 0.0.0.0 --port "$SERVICE_PORT"