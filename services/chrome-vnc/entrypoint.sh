#!/bin/bash
set -e

CDP_PORT="${CDP_PORT:-9222}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/chrome-profile}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

echo "=============================================="
echo " X Followers Sweep — Chrome + VNC"
echo "=============================================="
echo " CDP:  port $CDP_PORT"
echo " VNC:  port $VNC_PORT"
echo " noVNC: port $NOVNC_PORT"
echo ""

mkdir -p "$CHROME_PROFILE_DIR"

# Clear stale profile locks
rm -f "$CHROME_PROFILE_DIR"/SingletonLock "$CHROME_PROFILE_DIR"/SingletonCookie "$CHROME_PROFILE_DIR"/SingletonSocket 2>/dev/null

echo "[1] Starting Xvfb..."
Xvfb :99 -screen 0 414x896x24 &
sleep 1

echo "[2] Starting Fluxbox..."
fluxbox &
sleep 1

echo "[3] Starting x11vnc..."
x11vnc -display :99 -forever -shared -rfbport "$VNC_PORT" -nopw -quiet &
sleep 1

echo "[4] Starting noVNC..."
/opt/noVNC/utils/novnc_proxy \
    --vnc "localhost:$VNC_PORT" \
    --listen "$NOVNC_PORT" \
    --web /opt/noVNC \
    > /tmp/novnc.log 2>&1 &
sleep 2

echo "[5] Starting Chrome..."
google-chrome-stable \
    --disable-gpu \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --no-first-run \
    --password-store=basic \
    --remote-debugging-port="$CDP_PORT" \
    --remote-debugging-address=0.0.0.0 \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --window-size=414,896 \
    https://x.com/login \
    &
CHROME_PID=$!

for i in $(seq 1 30); do
    if curl -s "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo "  Chrome ready (PID: $CHROME_PID)"
        break
    fi
    sleep 1
done

echo "Ready. CDP: :$CDP_PORT, VNC: :$VNC_PORT, noVNC: :$NOVNC_PORT"

# Chrome only listens on 127.0.0.1 despite --remote-debugging-address=0.0.0.0
# Proxy 0.0.0.0:$CDP_PORT -> 127.0.0.1:$CDP_PORT so kubelet probes work
python3 -c "
import asyncio, socket

async def proxy(client, target):
    while True:
        data = await asyncio.get_event_loop().sock_recv(client, 65536)
        if not data: break
        await asyncio.get_event_loop().sock_sendall(target, data)

async def server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', $CDP_PORT))
    srv.listen(5)
    srv.setblocking(False)
    print(f'CDP proxy on 0.0.0.0:$CDP_PORT -> 127.0.0.1:$CDP_PORT')
    while True:
        client, _ = await asyncio.get_event_loop().sock_accept(srv)
        target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        target.connect(('127.0.0.1', $CDP_PORT))
        asyncio.ensure_future(proxy(client, target))
        asyncio.ensure_future(proxy(target, client))

asyncio.run(server())
" &
sleep 1

echo "All services running. Waiting forever..."

# Keep container alive
tail -f /dev/null