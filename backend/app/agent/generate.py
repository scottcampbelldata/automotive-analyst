"""
Natural-language -> SQL generation. Provider is swappable via env:
  AGENT_PROVIDER = anthropic (default) | ollama
The model only produces SQL text; guardrails.py validates it before execution.
"""
import re
import httpx

from ..config import (
    AGENT_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
    OLLAMA_BASE, OLLAMA_MODEL,
)
from .schema_context import SCHEMA_PROMPT, build_messages


def _strip(sql: str) -> str:
    s = re.sub(r'^```(?:sql)?', '', sql.strip()).strip()
    s = re.sub(r'```$', '', s).strip()
    return s


async def generate_sql(question: str) -> str:
    """Return raw SQL text from the model (unvalidated)."""
    if AGENT_PROVIDER == "ollama":
        return await _ollama(question)
    return await _anthropic(question)


async def _anthropic(question: str) -> str:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Set it in the environment, or set "
            "AGENT_PROVIDER=ollama to use a local model."
        )
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 600,
        "system": SCHEMA_PROMPT,
        "messages": build_messages(question),
    }
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages", json=payload, headers=headers
        )
        r.raise_for_status()
        data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _strip(text)


async def _ollama(question: str) -> str:
    prompt = SCHEMA_PROMPT + "\n\nQuestion: " + question + "\nSQL:"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{OLLAMA_BASE}/api/generate",
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
        )
        r.raise_for_status()
        return _strip(r.json().get("response", ""))
