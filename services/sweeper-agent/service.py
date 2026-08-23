#!/usr/bin/env python3
"""X cleanup fulfiller backed by official X API reads and an LLM reviewer."""

import asyncio, inspect, json, os, re, time, uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from openai import AsyncOpenAI

from tools import BrowserTools
from x_api_adapter import XApiAdapterClient, XApiAdapterError
from platform_adapter import (
    DELIVER_TOPIC,
    GooglePubSubPublisher,
    OutcomeEngineContextLoader,
    OutcomeEngineSweepLoader,
    PubSubRuntime,
    PubSubSettings,
    SweepTaskHandler,
    sweep_delivery_command,
    unfollow_delivery_command,
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

    # Prefer the existing X tab so the fulfiller neither hijacks an unrelated
    # authenticated tab nor depends on Target.getTargets ordering.
    page = next((candidate for candidate in pages if candidate.get("url", "").startswith("https://x.com/")), pages[0])
    attach = await send("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
    psid = attach.get("sessionId", "")
    return ws, psid

# ── LLM review ────────────────────────────────────────────────────────────

REVIEW_SYSTEM_PROMPT = """You are an X (Twitter) cleanup reviewer for @dlt_alx.

You receive structured profile evidence from the authenticated X account. Decide whether each
account should be kept or marked as an unfollow candidate. This is a dry run: you only make
and explain decisions; you never perform account changes.

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

Return ONLY a JSON array with one item for every supplied profile, in the same order:
[{"handle": "@name", "decision": "UNFOLLOW|KEEP", "reason": "..."}]

No markdown, no code fences, no explanations after the JSON. Just the array."""

# ── Models ─────────────────────────────────────────────────────────────────

class ReviewRequest(BaseModel):
    handles: list[str]
    mode: str = Field(default="dry-run", pattern="^(dry-run|auto-unfollow)$")

class ReviewResult(BaseModel):
    handle: str
    decision: str = ""
    reason: str = ""
    screenshot: Optional[str] = None
    error: Optional[str] = None

class ReviewResponse(BaseModel):
    results: list[ReviewResult]

class CandidateRequest(BaseModel):
    count: int = Field(default=3, ge=1, le=500)

class CandidateResponse(BaseModel):
    candidates: list[str]
    total_found: int = 0

class SweepRequest(BaseModel):
    id: uuid.UUID
    mode: str = Field(default="dry-run", pattern="^(dry-run|auto-unfollow)$")
    count: int = Field(default=3, ge=1, le=500)

class SweepAccepted(BaseModel):
    id: uuid.UUID
    status: str = "accepted"


class UnfollowRequest(BaseModel):
    id: uuid.UUID
    handle: str = Field(pattern=r"^@[A-Za-z0-9_]{1,15}$")


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


def _normalize_review_results(raw_results: list, handles: list[str]) -> list[dict]:
    """Validate that the model reviewed every requested handle exactly once."""
    expected = {handle.casefold(): handle for handle in handles}
    normalized: dict[str, dict] = {}
    for raw in raw_results:
        if not isinstance(raw, dict):
            raise ValueError("review result was not an object")
        handle = str(raw.get("handle", "")).strip()
        if handle and not handle.startswith("@"):
            handle = f"@{handle}"
        key = handle.casefold()
        decision = str(raw.get("decision", "")).strip().upper()
        reason = str(raw.get("reason", "")).strip()
        if key not in expected:
            raise ValueError(f"review returned an unexpected handle: {handle or '<missing>'}")
        if key in normalized:
            raise ValueError(f"review returned duplicate handle: {handle}")
        if decision not in {"KEEP", "UNFOLLOW"}:
            raise ValueError(f"review returned an invalid decision for {handle}")
        if not reason:
            raise ValueError(f"review returned no reason for {handle}")
        normalized[key] = {
            "handle": expected[key],
            "decision": decision,
            "reason": reason,
        }
    missing = [handle for handle in handles if handle.casefold() not in normalized]
    if missing:
        raise ValueError(f"review omitted handles: {', '.join(missing)}")
    return [normalized[handle.casefold()] for handle in handles]


REVIEW_BATCH_SIZE = 20


async def _decide_review_batch(profiles: list[dict], handles: list[str]) -> list[dict]:
    """Ask the configured model for one complete, validated bounded review batch."""
    prompt = "Review this profile evidence:\n" + json.dumps(profiles, ensure_ascii=False)
    previous = ""
    validation_error = ""
    for attempt in range(2):
        user_prompt = prompt
        if attempt:
            user_prompt += (
                "\n\nYour previous response was invalid. Return the complete JSON array again."
                f"\nValidation error: {validation_error}\nPrevious response: {previous}"
            )
        response = await client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[
                {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=2000,
            temperature=0.1,
        )
        previous = response.choices[0].message.content or ""
        try:
            return _normalize_review_results(_parse_json_array(previous), handles)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            validation_error = str(exc)
    raise ValueError(f"agent did not return a complete review: {validation_error}")


async def _decide_reviews(profiles: list[dict], handles: list[str]) -> list[dict]:
    """Review large sweeps in bounded model calls while preserving handle order."""
    results = []
    for start in range(0, len(handles), REVIEW_BATCH_SIZE):
        end = start + REVIEW_BATCH_SIZE
        results.extend(await _decide_review_batch(profiles[start:end], handles[start:end]))
    return results

# ── FastAPI app ────────────────────────────────────────────────────────────

async def _load_x_account(app: FastAPI, adapter: XApiAdapterClient) -> None:
    """Wait briefly for the adapter Service during a simultaneous rollout."""
    attempts = 10
    for attempt in range(1, attempts + 1):
        try:
            account = await adapter.account()
            app.state.x_account = account
            app.state.x_api_error = None
            print(f"X API: authorized as @{account.get('username', 'unknown')}", flush=True)
            return
        except Exception as error:
            app.state.x_api_error = str(error)
            retryable = isinstance(error, XApiAdapterError) and str(error).startswith(
                "x-api-adapter unavailable:"
            )
            if not retryable or attempt == attempts:
                print(f"X API: {error}", flush=True)
                return
            await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    platform_enabled = os.environ.get("SWEEPER_PLATFORM_ENABLED", "false").lower() in {"1", "true", "yes"}
    platform_runtime = None
    if platform_enabled:
        try:
            settings = PubSubSettings.from_env()
            publisher = GooglePubSubPublisher(settings.project_id, settings.topic_prefix)
            adapter_url = os.environ.get("X_API_ADAPTER_URL", "").strip()
            if adapter_url:
                adapter = XApiAdapterClient(adapter_url)
                executor = ApiSweepExecutor(adapter, BrowserSweepExecutor())
                app.state.x_api_adapter = adapter
                app.state.sweep_executor = executor
            else:
                executor = BrowserSweepExecutor()
                app.state.sweep_executor = executor
            handler = SweepTaskHandler(publisher, executor, OutcomeEngineContextLoader(settings.outcome_engine_url))
            platform_runtime = PubSubRuntime(settings, handler, publisher)
            platform_runtime.start(asyncio.get_running_loop())
            app.state.sweep_publisher = publisher
            app.state.sweep_loader = OutcomeEngineSweepLoader(settings.outcome_engine_url)
            app.state.platform_runtime = platform_runtime
            print(f"Outcome Engine fulfiller: listening on {settings.subscription_id}", flush=True)
        except Exception as e:
            app.state.platform_error = str(e)
            print(f"Outcome Engine fulfiller: {e}", flush=True)
    adapter = getattr(app.state, "x_api_adapter", None)
    if adapter is not None:
        await _load_x_account(app, adapter)
    else:
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
    adapter = getattr(app.state, "x_api_adapter", None)
    if adapter is not None:
        await adapter.close()

app = FastAPI(title="X Cleanup Service v2 (LLM-driven)", version="2.0.0", lifespan=lifespan)

# CORS for the web frontend (x-sweeper-web.s26.staging.adlt.dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://x-sweeper-web.s26.staging.adlt.dev",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
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


@app.post(
    "/api/v1/sweeps/{sweep_id}/unfollows",
    response_model=SweepAccepted,
    status_code=202,
)
async def accept_unfollow(sweep_id: uuid.UUID, req: UnfollowRequest):
    """Accept one explicit action only when the persisted review selected it."""
    publisher = getattr(app.state, "sweep_publisher", None)
    loader = getattr(app.state, "sweep_loader", None)
    if publisher is None or loader is None:
        raise HTTPException(503, "sweep platform is not configured")
    try:
        sweep = loader(str(sweep_id))
        if inspect.isawaitable(sweep):
            sweep = await sweep
    except Exception as exc:
        raise HTTPException(503, "could not load reviewed sweep") from exc

    context = sweep.get("context", {}) if isinstance(sweep, dict) else {}
    reviews = context.get("reviews", []) if isinstance(context, dict) else []
    selected = next(
        (
            review
            for review in reviews
            if isinstance(review, dict)
            and str(review.get("handle", "")).casefold() == req.handle.casefold()
            and review.get("decision") == "UNFOLLOW"
        ),
        None,
    )
    if selected is None:
        raise HTTPException(409, "handle is not a reviewed UNFOLLOW decision")

    unfollow_id = str(req.id)
    try:
        await publisher.publish(
            DELIVER_TOPIC,
            unfollow_delivery_command(
                unfollow_id,
                str(sweep_id),
                str(sweep["deliveryId"]),
                str(selected["handle"]),
            ),
        )
    except Exception as exc:
        raise HTTPException(503, "could not accept unfollow") from exc
    return JSONResponse(
        status_code=202,
        headers={"Location": f"/api/v1/unfollows/{unfollow_id}"},
        content={"id": unfollow_id, "status": "accepted"},
    )


@app.post("/generate-candidates", response_model=CandidateResponse)
async def generate_candidates(req: CandidateRequest):
    """Read a bounded set of real handles from the authenticated Following list."""
    ws, psid = await _connect_chrome()
    try:
        bt = BrowserTools(ws, psid)
        candidates = await bt.collect_following_handles(req.count)
        return CandidateResponse(candidates=candidates, total_found=len(candidates))
    finally:
        await ws.close()


@app.post("/review-handles", response_model=ReviewResponse)
async def review_handles(req: ReviewRequest):
    """Collect real profile evidence and ask the configured model for dry-run decisions."""
    if not req.handles:
        raise HTTPException(400, "handles list is required")
    if len({handle.casefold() for handle in req.handles}) != len(req.handles):
        raise HTTPException(400, "handles must be unique")

    ws, psid = await _connect_chrome()
    try:
        bt = BrowserTools(ws, psid)
        profiles = []
        for handle in req.handles:
            await bt.navigate(f"https://x.com/{handle.lstrip('@')}")
            raw_profile = await bt.extract_profile()
            try:
                profile = json.loads(raw_profile)
            except (TypeError, json.JSONDecodeError):
                profile = {"raw": raw_profile}
            profiles.append({"handle": handle, **profile})

        decisions = await _decide_reviews(profiles, req.handles)
        for decision in decisions:
            if decision["decision"] != "UNFOLLOW":
                continue
            await bt.navigate(f"https://x.com/{decision['handle'].lstrip('@')}")
            filename = f"dry_run_{decision['handle'].lstrip('@')}_{uuid.uuid4().hex[:8]}.png"
            shot = await bt.screenshot(filename)
            if shot.startswith("Screenshot saved to "):
                decision["screenshot"] = shot.removeprefix("Screenshot saved to ")

        return ReviewResponse(results=[ReviewResult.model_validate(result) for result in decisions])
    finally:
        await ws.close()


class BrowserSweepExecutor:
    """Adapts the existing browser operations to Outcome Engine task execution."""

    async def generate_candidates(self, count: int) -> list[str]:
        response = await generate_candidates(CandidateRequest(count=count))
        return response.candidates

    async def review_handles(
        self,
        handles: list[str],
        mode: str,
        candidate_evidence: list[dict] | None = None,
    ) -> list[dict]:
        response = await review_handles(ReviewRequest(handles=handles, mode=mode))
        return [result.model_dump(exclude_none=True) for result in response.results]

    async def apply_unfollow(self, handle: str) -> dict:
        ws, psid = await _connect_chrome()
        try:
            browser = BrowserTools(ws, psid)
            await browser.navigate(f"https://x.com/{handle.lstrip('@')}")
            try:
                await browser.unfollow_current_profile()
            except RuntimeError as exc:
                if str(exc) == "profile is not currently followed":
                    return {
                        "handle": handle,
                        "status": "ALREADY_UNFOLLOWED",
                        "detail": str(exc),
                    }
                raise
            return {
                "handle": handle,
                "status": "APPLIED",
                "appliedAt": datetime.now(timezone.utc).isoformat(),
            }
        finally:
            await ws.close()

    async def apply_unfollows(self, reviews: list[dict]) -> list[dict]:
        results = []
        for review in reviews:
            if review.get("decision") != "UNFOLLOW":
                continue
            handle = str(review["handle"])
            try:
                results.append(await self.apply_unfollow(handle))
            except Exception as exc:
                results.append({
                    "handle": handle,
                    "status": "FAILED",
                    "detail": str(exc) or exc.__class__.__name__,
                })
        return results


class ApiSweepExecutor:
    """M1 executor: official X API reads, existing write path until the M2 API delete lands."""

    def __init__(self, adapter: XApiAdapterClient, write_executor: BrowserSweepExecutor) -> None:
        self.adapter = adapter
        self.write_executor = write_executor

    async def generate_candidates(self, count: int) -> dict:
        return await self.adapter.following(count)

    async def review_handles(
        self,
        handles: list[str],
        mode: str,
        candidate_evidence: list[dict] | None = None,
    ) -> list[dict]:
        evidence = candidate_evidence or []
        by_handle = {
            str(profile.get("handle", "")).casefold(): profile
            for profile in evidence
            if isinstance(profile, dict)
        }
        missing = [handle for handle in handles if handle.casefold() not in by_handle]
        if missing:
            raise ValueError(f"X_API_EVIDENCE_MISSING: {', '.join(missing)}")
        profiles = [by_handle[handle.casefold()] for handle in handles]
        decisions = await _decide_reviews(profiles, handles)
        for decision in decisions:
            profile = by_handle[decision["handle"].casefold()]
            decision["xUserId"] = profile["xUserId"]
        return decisions

    async def apply_unfollow(self, handle: str) -> dict:
        return await self.write_executor.apply_unfollow(handle)

    async def apply_unfollows(self, reviews: list[dict]) -> list[dict]:
        return await self.write_executor.apply_unfollows(reviews)


@app.get("/health")
async def health():
    status = {"service": "ok", "model": JUDGE_MODEL}
    adapter = getattr(app.state, "x_api_adapter", None)
    if adapter is not None:
        account = getattr(app.state, "x_account", None)
        status["xApi"] = {
            "configured": True,
            "account": f"@{account.get('username')}" if isinstance(account, dict) and account.get("username") else None,
            "error": getattr(app.state, "x_api_error", None),
        }
    else:
        try:
            # Probes run frequently and have a short timeout. Checking Chrome's CDP
            # discovery document proves it is reachable without opening a WebSocket.
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
