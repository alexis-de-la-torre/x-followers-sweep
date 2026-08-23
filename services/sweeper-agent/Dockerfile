# syntax=docker/dockerfile:1
FROM python:3.11-slim

LABEL description="X Followers Sweep - Outcome Engine fulfiller and LLM reviewer"
LABEL version="4.0"

ENV PYTHONUNBUFFERED=1
ENV SERVICE_PORT=8020

WORKDIR /app

COPY services/sweeper-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/sweeper-agent/service.py services/sweeper-agent/tools.py services/sweeper-agent/platform_adapter.py services/sweeper-agent/x_api_adapter.py ./
COPY services/sweeper-agent/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN mkdir -p /screenshots

EXPOSE $SERVICE_PORT

VOLUME ["/screenshots"]

ENTRYPOINT ["/entrypoint.sh"]
