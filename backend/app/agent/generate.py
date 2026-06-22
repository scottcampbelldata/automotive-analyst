"""
Natural-language -> SQL generation. Provider is swappable via env:
  AGENT_PROVIDER = anthropic (default) | ollama

The model only ever produces SQL text; guardrails.py validates it before it can
touch the database. Two entry points:
  - generate_sql(question)            first attempt
  - repair_sql(question, bad_sql, e)  one corrective turn when the DB rejects the
                                      first query (self-correction)
"""
import re
import httpx

from ..config import (
    AGENT_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
    OLLAMA_BASE, OLLAMA_MODEL,
)
from .schema_context import SCHEMA_PROMPT, build_messages, build_repair_messages


def _strip(sql: str) -> str:
    s = re.sub(r'^```(?:sql)?', '', sql.strip()).strip()
    s = re.sub(r'```$', '', s).strip()
    return s


async def generate_sql(question: str) -> str:
    """Return raw SQL text from the model (unvalidated) for a new question."""
    return await _complete(build_messages(question))


async def repair_sql(question: str, bad_sql: str, error: str) -> str:
    """Ask the model to fix SQL the database rejected. Returns raw SQL."""
    return await _complete(build_repair_messages(question, bad_sql, error))


async def _complete(messages: list[dict]) -> str:
    if AGENT_PROVIDER == "ollama":
        return await _ollama(messages)
    return await _anthropic(messages)


async def _anthropic(messages: list[dict]) -> str:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Set it in the environment, or set "
            "AGENT_PROVIDER=ollama to use a local model."
        )
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 600,
        "system": SCHEMA_PROMPT,
        "messages": messages,
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


async def _ollama(messages: list[dict]) -> str:
    # Flatten the chat turns into a single prompt for the completion API.
    convo = "\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages)
    prompt = f"{SCHEMA_PROMPT}\n\n{convo}\n\nASSISTANT:"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            f"{OLLAMA_BASE}/api/generate",
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
        )
        r.raise_for_status()
        return _strip(r.json().get("response", ""))
