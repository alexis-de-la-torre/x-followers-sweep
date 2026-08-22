#!/usr/bin/env python3
"""
X Cleanup Service v2 — LLM-driven agent with browser tools.

Uses DeepSeek V4 Flash via OpenRouter (OpenAI-compatible endpoint) with
native function calling to drive Chrome CDP.

POST /generate-candidates  — agent navigates /following, extracts handles, scores
POST /review-handles       — agent reviews each profile, decides, screenshots, unfollows
GET  /health               — Chrome + config check
"""

import asyncio, json, os, re, time, uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from openai import AsyncOpenAI

from tools import BrowserTools, BROWSER_TOOLS, execute_tool
from platform_adapter import (
    DELIVER_TOPIC,
    GooglePubSubPublisher,
    OutcomeEngineContextLoader,
    PubSubRuntime,
    PubSubSettings,
    SweepTaskHandler,
    sweep_delivery_command,
)

# ── Config ──────────────────────────────────────────────────────────────────

def _get_env_or_file(key: str, env_path: Path = None) -> str:
    val = os.environ.get(key, "")
    if not val and env_path and env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{key}="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    return val

_env_file = Path.home() / ".hermes" / ".env"
OPENROUTER_KEY = _get_env_or_file("OPENROUTER_API_KEY", _env_file)
if not OPENROUTER_KEY:
    raise RuntimeError("OPENROUTER_API_KEY required — set env or add to ~/.hermes/.env")

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "deepseek/deepseek-v4-flash")
BROWSER_WS_URL = os.environ.get("BROWSER_WS")
SHOTS_DIR = Path(os.environ.get("SCREENSHOT_DIR", "/screenshots"))
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

# OpenRouter client (OpenAI-compatible)
client = AsyncOpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")

# ── Chrome CDP connection ──────────────────────────────────────────────────

async def _get_cdp_url() -> str:
    """Get the WebSocket debugger URL from Chrome's HTTP endpoint."""
    import httpx
    url = BROWSER_WS_URL or "http://localhost:9222/json/version"
    async with httpx.AsyncClient(timeout=10) as hc:
        resp = await hc.get(url)
        resp.raise_for_status()
        debugger_url = resp.json()["webSocketDebuggerUrl"]

    # Chrome builds this URL from the Host header. The CDP proxy must send a
    # loopback Host so Chrome accepts the request, which means Chrome advertises
    # 127.0.0.1 even when it is running in another pod. Keep Chrome's browser ID
    # but connect through the configured discovery endpoint instead.
    discovery = urlsplit(url)
    debugger = urlsplit(debugger_url)
    websocket_scheme = "wss" if discovery.scheme in {"https", "wss"} else "ws"
    return urlunsplit((
        websocket_scheme,
        discovery.netloc,
        debugger.path,
        debugger.query,
        debugger.fragment,
    ))

async def _connect_chrome():
    """Connect to Chrome CDP and attach to the first page. Returns (ws, psid)."""
    import websockets
    wsu = await _get_cdp_url()
    ws = await websockets.connect(wsu, max_size=200*1024*1024)

    # Get targets
    nid = [0]
    async def send(m, p=None, sid=None):
        nid[0] += 1
        cmd = {"id": nid[0], "method": m, "params": p or {}}
        if sid: cmd["sessionId"] = sid
        await ws.send(json.dumps(cmd))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            resp = json.loads(raw)
            if resp.get("id") == nid[0]:
                return resp.get("result", {})
        raise TimeoutError(f"CDP timeout: {m}")

    targets = await send("Target.getTargets")
    pages = [t for t in targets.get("targetInfos", []) if t["type"] == "page"]
    if not pages:
        # Create a new page
        await send("Target.createTarget", {"url": "about:blank"})
        targets = await send("Target.getTargets")
        pages = [t for t in targets.get("targetInfos", []) if t["type"] == "page"]

    attach = await send("Target.attachToTarget", {"targetId": pages[0]["targetId"], "flatten": True})
    psid = attach.get("sessionId", "")
    return ws, psid

# ── LLM Agent Loop ────────────────────────────────────────────────────────

AGENT_SYSTEM_PROMPT = """You are an X (Twitter) cleanup assistant for @dlt_alx.

You have browser tools to navigate, extract profile data, take screenshots, and unfollow accounts.

**Your task:** Review X accounts and decide whether to unfollow them.

**UNFOLLOW when:**
- Dead account (no posts, or last post >12 months ago)
- Spam/follow-bot (follows >2000 followers <200, empty bio)
- Mass-follower with no engagement (following >5x followers)
- Pure crypto/NFT/web3/growth-hacker/marketing spam
- Obvious bot (keyboard-smash name, 0 posts, default avatar)
- Low-value to timeline (ecom/dropshipping/guru content)
- When in doubt, lean toward UNFOLLOW

**KEEP when:**
- Active with relevant content (AI/ML, coding, startups, science, retro gaming)
- Notable person in tech/science/art
- Friend or acquaintance
- Posted in last 6 months with genuine content

**Tool flow for reviewing a handle:**
1. navigate(url) to the profile
2. extract_profile() to get post dates, bio, content
3. Decide UNFOLLOW or KEEP
4. If UNFOLLOW: screenshot() then click_unfollow()
5. Report your decision

When you have reviewed ALL handles, your final message MUST be ONLY a JSON array with NO other text:
[{"handle": "@name", "decision": "UNFOLLOW|KEEP", "reason": "..."}]

No markdown, no code fences, no explanations after the JSON. Just the array."""

REVIEW_TASK_TEMPLATE = """Review these X handles one by one. For each:
1. Navigate to their profile
2. Extract their profile data
3. Decide UNFOLLOW or KEEP
4. If UNFOLLOW: take a screenshot and unfollow
5. Report the result

Handles to review: {handles}
Mode: {mode} (dry-run = screenshot only, no unfollow; execute = screenshot + unfollow)
"""

CANDIDATE_TASK = """Navigate to https://x.com/dlt_alx/following, scroll down repeatedly to load the following list, and extract as many handles as you can see. 

For each handle you find, try to get their post count (the number shown on their row in the following list) and return a list of handles.

After you've scrolled enough and collected handles, report the bottom 30 handles (the oldest follows — these are most likely dead).

Return them as a JSON array: ["@handle1", "@handle2", ...]
"""

async def run_agent(task: str, tools: BrowserTools, max_steps: int = 25) -> str:
    """Run the LLM agent loop. Returns the final response text."""
    messages = [
        {"role": "system", "content": AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": task}
    ]

    for step in range(max_steps):
        # Call the LLM
        resp = await client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=messages,
            tools=BROWSER_TOOLS,
            tool_choice="auto",
            max_tokens=2000,
            temperature=0.1,
        )

        choice = resp.choices[0]
        msg = choice.message

        # If no tool calls, the agent is done
        if not msg.tool_calls:
            return msg.content or "No response"

        # Process each tool call
        messages.append({"role": "assistant", "content": msg.content or "", "tool_calls": [
            {"id": tc.id, "function": {"name": tc.function.name, "arguments": tc.function.arguments}, "type": "function"}
            for tc in msg.tool_calls
        ]})

        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            except json.JSONDecodeError:
                args = {}

            result = await execute_tool(tools, name, args)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result
            })

        # Small delay between steps to avoid rate limits
        await asyncio.sleep(0.5)

    return "Max steps reached. Partial results:\n" + str(messages[-1].get("content", ""))

# ── Models ─────────────────────────────────────────────────────────────────

class ReviewRequest(BaseModel):
    handles: list[str]
    mode: str = "dry-run"

class ReviewResult(BaseModel):
    handle: str
    decision: str = ""
    reason: str = ""
    screenshot: Optional[str] = None
    error: Optional[str] = None

class ReviewResponse(BaseModel):
    results: list[ReviewResult]

class CandidateRequest(BaseModel):
    count: int = 30

class CandidateResponse(BaseModel):
    candidates: list[str]
    total_found: int = 0

class SweepRequest(BaseModel):
    id: uuid.UUID
    mode: str = Field(default="dry-run", pattern="^dry-run$")
    count: int = Field(default=30, ge=1, le=30)

class SweepAccepted(BaseModel):
    id: uuid.UUID
    status: str = "accepted"


def _parse_json_array(text: str) -> list:
    """Parse an agent JSON array, tolerating an accidental Markdown fence/preamble."""
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("["), candidate.rfind("]")
        if start < 0 or end < start:
            raise ValueError("agent response did not contain a JSON array")
        value = json.loads(candidate[start:end + 1])
    if not isinstance(value, list):
        raise ValueError("agent response was not a JSON array")
    return value

# ── FastAPI app ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    platform_enabled = os.environ.get("SWEEPER_PLATFORM_ENABLED", "false").lower() in {"1", "true", "yes"}
    platform_runtime = None
    if platform_enabled:
        try:
            settings = PubSubSettings.from_env()
            publisher = GooglePubSubPublisher(settings.project_id, settings.topic_prefix)
            executor = BrowserSweepExecutor()
            handler = SweepTaskHandler(publisher, executor, OutcomeEngineContextLoader(settings.outcome_engine_url))
            platform_runtime = PubSubRuntime(settings, handler, publisher)
            platform_runtime.start(asyncio.get_running_loop())
            app.state.sweep_publisher = publisher
            app.state.platform_runtime = platform_runtime
            print(f"Outcome Engine fulfiller: listening on {settings.subscription_id}", flush=True)
        except Exception as e:
            app.state.platform_error = str(e)
            print(f"Outcome Engine fulfiller: {e}", flush=True)
    # Startup: verify Chrome and config
    try:
        ws, psid = await _connect_chrome()
        await ws.close()
        print("Chrome CDP: OK", flush=True)
    except Exception as e:
        print(f"Chrome CDP: {e}", flush=True)
    print(f"Model: {JUDGE_MODEL}", flush=True)
    yield
    if platform_runtime is not None:
        await platform_runtime.stop()

app = FastAPI(title="X Cleanup Service v2 (LLM-driven)", version="2.0.0", lifespan=lifespan)

# CORS for the web frontend (x-sweeper-web.s26.staging.adlt.dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://x-sweeper-web.s26.staging.adlt.dev",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.post("/api/v1/sweeps", response_model=SweepAccepted, status_code=202)
async def accept_sweep(req: SweepRequest):
    """Accept a sweep after its pinned flow has been published to Outcome Engine."""
    publisher = getattr(app.state, "sweep_publisher", None)
    if publisher is None:
        raise HTTPException(503, "sweep publisher is not configured")
    sweep_id = str(req.id)
    try:
        await publisher.publish(
            DELIVER_TOPIC,
            sweep_delivery_command(sweep_id, req.mode, req.count),
        )
    except Exception as exc:
        raise HTTPException(503, "could not accept sweep") from exc
    return JSONResponse(
        status_code=202,
        headers={"Location": f"/api/v1/sweeps/{sweep_id}"},
        content={"id": sweep_id, "status": "accepted"},
    )


@app.post("/generate-candidates", response_model=CandidateResponse)
async def generate_candidates(req: CandidateRequest):
    """LLM-driven: navigate /following, scroll, extract handles, return list."""
    ws, psid = await _connect_chrome()
    try:
        bt = BrowserTools(ws, psid)
        result_text = await run_agent(CANDIDATE_TASK, bt, max_steps=20)

        raw_candidates = _parse_json_array(result_text)
        candidates = [handle for handle in raw_candidates if isinstance(handle, str)][:req.count]
        return CandidateResponse(candidates=candidates, total_found=len(raw_candidates))
    finally:
        await ws.close()


@app.post("/review-handles", response_model=ReviewResponse)
async def review_handles(req: ReviewRequest):
    """LLM-driven: review each handle, decide, screenshot + unfollow."""
    if not req.handles:
        raise HTTPException(400, "handles list is required")

    ws, psid = await _connect_chrome()
    try:
        bt = BrowserTools(ws, psid)
        task = REVIEW_TASK_TEMPLATE.format(handles=json.dumps(req.handles), mode=req.mode)
        result_text = await run_agent(task, bt, max_steps=len(req.handles) * 5 + 5)

        raw_results = _parse_json_array(result_text)
        return ReviewResponse(results=[ReviewResult.model_validate(result) for result in raw_results])
    finally:
        await ws.close()


class BrowserSweepExecutor:
    """Adapts the existing browser operations to Outcome Engine task execution."""

    async def generate_candidates(self, count: int) -> list[str]:
        response = await generate_candidates(CandidateRequest(count=count))
        return response.candidates

    async def review_handles(self, handles: list[str], mode: str) -> list[dict]:
        response = await review_handles(ReviewRequest(handles=handles, mode=mode))
        return [result.model_dump(exclude_none=True) for result in response.results]


@app.get("/health")
async def health():
    status = {"service": "ok", "model": JUDGE_MODEL}
    try:
        # Probes run frequently and have a short timeout. Checking Chrome's CDP
        # discovery document proves it is reachable without opening and tearing
        # down a browser WebSocket session for every liveness/readiness request.
        await _get_cdp_url()
        status["chrome"] = "ok"
    except Exception as e:
        status["chrome"] = f"error: {e}"
    status["openrouter"] = "configured"
    runtime = getattr(app.state, "platform_runtime", None)
    if runtime is not None:
        status["outcomeEngine"] = runtime.health()
    else:
        status["outcomeEngine"] = {
            "configured": False,
            "error": getattr(app.state, "platform_error", None),
        }
    return status


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8020"))
    uvicorn.run(app, host=host, port=port)
