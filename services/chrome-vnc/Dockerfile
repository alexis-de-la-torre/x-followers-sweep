# syntax=docker/dockerfile:1
FROM python:3.11-slim

LABEL description="X Followers Sweep - Chrome + VNC browser access"
LABEL version="1.0"

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV CHROME_PROFILE_DIR=/chrome-profile
ENV CDP_PORT=9222
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates curl git \
    xvfb x11vnc fluxbox \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify \
    && rm -rf /opt/noVNC/.git /opt/noVNC/utils/websockify/.git \
    && echo '<meta http-equiv=refresh content=0;url=/vnc.html>' > /opt/noVNC/index.html

COPY services/chrome-vnc/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE $CDP_PORT $VNC_PORT $NOVNC_PORT

VOLUME ["/chrome-profile"]

ENTRYPOINT ["/entrypoint.sh"]