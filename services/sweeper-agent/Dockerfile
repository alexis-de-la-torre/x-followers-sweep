# syntax=docker/dockerfile:1
FROM python:3.11-slim

LABEL description="X Cleanup Service — LLM-driven browser agent with VNC access"
LABEL version="3.0"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:99
ENV CHROME_PROFILE_DIR=/chrome-profile
ENV SERVICE_PORT=8020
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080

# Install system deps + Chrome + VNC + window manager
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates curl git \
    xvfb x11vnc fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install cloudflared
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Install noVNC web client
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify \
    && rm -rf /opt/noVNC/.git /opt/noVNC/utils/websockify/.git \
    && echo '<meta http-equiv=refresh content=0;url=/vnc.html>' > /opt/noVNC/index.html

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Service code
COPY service.py tools.py ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /screenshots

EXPOSE $SERVICE_PORT $VNC_PORT $NOVNC_PORT

VOLUME ["/chrome-profile", "/screenshots"]

ENTRYPOINT ["/entrypoint.sh"]