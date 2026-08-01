"""
Text-to-SQL agent endpoints (Project 2) - the server half of a bring-your-own-key
design. SQL is generated in the visitor's browser (Claude/OpenAI/Gemini, their
key); this service never sees a key.

  GET  /api/ask/samples   example questions for the UI
  GET  /api/ask/context   schema grounding (system prompt + few-shot) for the browser
  POST /api/ask/run       { question, sql } -> guardrails -> read-only execute

/run accepts client-supplied SQL on purpose: it is validated by the guardrails
(allow-list, SELECT-only, single statement) and executed as a read-only role
inside a read-only transaction with a statement timeout. Even a hostile client
cannot write or escape the allow-list - the design fails safe.
"""
import logging
import re
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..agent.guardrails import validate_sql
from ..agent.runner import run_readonly, viz_hint
from ..agent.schema_context import context as schema_context
from ..config import MAX_QUESTION_CHARS, MAX_SQL_CHARS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S
from ..ratelimit import FixedWindowLimiter

log = logging.getLogger("agent.ask")
router = APIRouter(prefix="/api/ask", tags=["agent"])
limiter = FixedWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S)

# Postgres errors are useful to the browser's one-shot repair pass (it feeds the
# message back to the model to fix the SQL), but the raw asyncpg string carries
# server-internal DETAIL/HINT/CONTEXT lines, file/line positions and occasionally
# role names. Keep the first line, which is the part that identifies the mistake,
# and drop the rest. The schema itself is public via /api/ask/context, so column
# names in that first line disclose nothing new.
_ERROR_NOISE = re.compile(r'\n\s*(DETAIL|HINT|CONTEXT|LINE \d+|QUERY|STATEMENT)\s*:.*', re.S | re.I)
MAX_ERROR_CHARS = 300


def _safe_db_error(e: Exception) -> str:
    lines = _ERROR_NOISE.sub('', str(e)).strip().splitlines()
    first = lines[0].strip() if lines else ''
    return first[:MAX_ERROR_CHARS] or "the query could not be executed"


SAMPLES = [
    "Which station lost the most hours on D-crew last quarter?",
    "What is our overall OEE and its three components?",
    "Which robots have a rising fault trend?",
    "How did spot-weld defects change month over month?",
    "Compare yield by line.",
    "Which crew has the slowest mean time to repair, and by how much?",
    "Where do most defects originate vs where are they detected?",
    "What were the worst 5 fault codes by total downtime?",
]


class RunRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=MAX_SQL_CHARS)
    question: str = Field("", max_length=MAX_QUESTION_CHARS)


@router.get("/samples")
async def samples():
    return SAMPLES


@router.get("/context")
async def context():
    """Schema grounding for the browser to assemble its provider request."""
    return schema_context()


@router.post("/run")
async def run(req: RunRequest, request: Request):
    limiter.check(request)  # raises 429 if over the per-IP limit

    # 1. validate (guardrails) - the SQL came from the client; trust nothing.
    ok, msg, sql = validate_sql(req.sql)
    if not ok:
        log.info("guardrail rejected (%s): %r", msg, req.sql[:200])
        return {
            "ok": False, "stage": "guardrail", "error": msg,
            "sql": req.sql, "guardrail": "rejected",
        }

    # 2. execute (read-only).
    started = time.monotonic()
    try:
        columns, rows = await run_readonly(sql)
    except TimeoutError:
        # Every pooled connection is busy. Say so plainly instead of hanging.
        log.warning("pool exhausted; rejecting request")
        raise HTTPException(
            status_code=503,
            detail="The analyst database is busy right now - try again in a moment.",
            headers={"Retry-After": "5"},
        ) from None
    except Exception as e:
        log.info("execute failed: %s", e)
        return {
            "ok": False, "stage": "execute", "error": _safe_db_error(e),
            "sql": sql, "guardrail": "passed (read-only, validated)",
        }

    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "ran q=%r rows=%d in %dms", (req.question or "")[:80], len(rows), elapsed_ms
    )
    return {
        "ok": True,
        "question": req.question,
        "sql": sql,
        "guardrail": "passed (read-only, validated, single-statement)",
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "viz": viz_hint(columns, rows),
    }
