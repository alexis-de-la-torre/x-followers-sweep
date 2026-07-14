#!/usr/bin/env python3
"""
Browser tools for the LLM-driven agent — lightweight CDP wrappers.

Each tool is a function the LLM can call. Returns serializable dicts.
"""

import asyncio, json, os, base64, re
from pathlib import Path

SHOTS_DIR = Path(os.environ.get("SCREENSHOT_DIR", "/screenshots"))
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Tool definitions (passed to the LLM as functions) ───────────────────

BROWSER_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "navigate",
            "description": "Navigate the browser to a URL and wait for the page to load",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL to navigate to"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "extract_profile",
            "description": "Extract profile information from the current page: last post date, bio, display name, post count",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "screenshot",
            "description": "Take a screenshot of the current page and save it. Returns the file path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Optional filename (without path)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "click_unfollow",
            "description": "Find and click the 'Following' button to open the unfollow menu, then click 'Unfollow' to confirm. Works on X/Twitter profile pages.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "scroll",
            "description": "Scroll the page by a number of pixels. Positive = down, negative = up.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pixels": {"type": "integer", "description": "Pixels to scroll (positive=down, negative=up)"}
                },
                "required": ["pixels"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "extract_page_text",
            "description": "Get the visible text content of the current page (first 2000 chars)",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_page_title",
            "description": "Get the current page title",
            "parameters": {"type": "object", "properties": {}}
        }
    }
]


class BrowserTools:
    """Executes browser actions via CDP WebSocket. Each method maps to a tool."""

    def __init__(self, ws, psid: str):
        self.ws = ws
        self.psid = psid
        self._nid = 0

    async def _send(self, method: str, params: dict = None) -> dict:
        self._nid += 1
        cmd = {"id": self._nid, "method": method, "params": params or {}}
        if self.psid:
            cmd["sessionId"] = self.psid
        await self.ws.send(json.dumps(cmd))
        deadline = asyncio.get_event_loop().time() + 15
        while asyncio.get_event_loop().time() < deadline:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=5)
            resp = json.loads(raw)
            if resp.get("id") == self._nid:
                return resp.get("result", {})
        raise TimeoutError(f"CDP command timed out: {method}")

    async def _evaluate(self, js: str) -> any:
        """Evaluate JS and return the value."""
        result = await self._send("Runtime.evaluate", {"expression": js})
        exc = result.get("result", {}).get("exceptionDetails")
        if exc:
            return f"JS Error: {exc.get('text', '')}"
        return result.get("result", {}).get("value")

    async def navigate(self, url: str) -> str:
        await self._send("Page.navigate", {"url": url})
        await asyncio.sleep(3)
        return f"Navigated to {url}"

    async def extract_profile(self) -> str:
        """Extract X profile info via JS."""
        js = """
        (() => {
            const times = [...document.querySelectorAll('article time')]
                .map(t => t.getAttribute('datetime')).filter(Boolean);
            const last = times.length ? times.reduce((a,b) => a>b ? a : b) : 'NO_POSTS';
            const bio = (document.querySelector('[data-testid=\"UserDescription\"]') || {}).innerText || '';
            const title = document.title;
            const posts = [...document.querySelectorAll('article')].slice(0,3)
                .map(a => a.innerText.slice(0,200)).join('\\n---\\n');
            const btn = [...document.querySelectorAll('button')].filter(b =>
                b.getAttribute('aria-label')?.includes('Following') ||
                b.textContent.trim() === 'Following'
            ).map(b => ({aria: b.getAttribute('aria-label'), text: b.textContent.trim().slice(0,20)}));
            return JSON.stringify({last, bio: bio.slice(0,300), title, posts: posts.slice(0,500), buttons: btn.slice(0,3)});
        })()
        """
        raw = await self._evaluate(js)
        return raw or "Could not extract profile"

    async def screenshot(self, filename: str = None) -> str:
        if not filename:
            filename = f"shot_{os.urandom(4).hex()}.png"
        path = str(SHOTS_DIR / filename)
        result = await self._send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        data = result.get("data", "")
        if data:
            with open(path, "wb") as f:
                f.write(base64.b64decode(data))
            return f"Screenshot saved to {path}"
        return "Screenshot failed"

    async def click_unfollow(self) -> str:
        """Click Following → Unfollow. Works on X profiles."""
        # First click the "Following @handle" button
        find = await self._evaluate("""
            (() => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => b.getAttribute('aria-label')?.startsWith('Following @'));
                if(btn) { btn.click(); return 'clicked'; }
                // Try text match
                const btn2 = [...document.querySelectorAll('button')]
                    .find(b => b.textContent.trim() === 'Following' && !b.querySelector('a'));
                if(btn2) { btn2.click(); return 'clicked'; }
                return 'not found';
            })()
        """)
        if find != "clicked":
            return f"Could not find Following button: {find}"
        await asyncio.sleep(2)
        # Click the "Unfollow" confirmation
        unfollow = await self._evaluate("""
            (() => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => b.textContent.trim() === 'Unfollow');
                if(btn) { btn.click(); return 'unfollowed'; }
                return 'not found';
            })()
        """)
        await asyncio.sleep(1)
        return f"Unfollow action: {unfollow}"

    async def scroll(self, pixels: int = 8000) -> str:
        await self._evaluate(f"window.scrollBy(0, {pixels})")
        await asyncio.sleep(0.5)
        return f"Scrolled {pixels}px"

    async def extract_page_text(self) -> str:
        text = await self._evaluate("document.body.innerText.slice(0, 3000)")
        return (text or "")[:2000]

    async def get_page_title(self) -> str:
        title = await self._evaluate("document.title")
        return title or "No title"


# ── Tool name → method dispatcher ───────────────────────────────────────

TOOL_MAP = {
    "navigate": BrowserTools.navigate,
    "extract_profile": BrowserTools.extract_profile,
    "screenshot": BrowserTools.screenshot,
    "click_unfollow": BrowserTools.click_unfollow,
    "scroll": BrowserTools.scroll,
    "extract_page_text": BrowserTools.extract_page_text,
    "get_page_title": BrowserTools.get_page_title,
}

async def execute_tool(tools: BrowserTools, name: str, args: dict) -> str:
    """Execute a named tool with args. Returns a string result."""
    method = TOOL_MAP.get(name)
    if not method:
        return f"Unknown tool: {name}"
    try:
        result = await method(tools, **args)
        return str(result) if result is not None else "ok"
    except Exception as e:
        return f"Tool error ({name}): {e}"