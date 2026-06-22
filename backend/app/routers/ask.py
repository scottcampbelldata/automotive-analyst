"""
Text-to-SQL agent endpoint (Project 2).

Flow:  rate-limit -> validate input -> LLM generates SQL -> guardrails ->
       read-only execute -> (one self-correction retry on DB error)

Every response returns the generated SQL and the guardrail status, so the user
always sees the query behind the answer. The SQL the model writes is never
trusted: it only runs after passing guardrails AND as a read-only DB role.
"""
import logging
import time

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..agent.generate import generate_sql, repair_sql
from ..agent.guardrails import validate_sql
from ..agent.runner import run_readonly, viz_hint
from ..config import MAX_QUESTION_CHARS, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S
from ..ratelimit import FixedWindowLimiter

log = logging.getLogger("agent.ask")
router = APIRouter(prefix="/api/ask", tags=["agent"])
limiter = FixedWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S)

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


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_CHARS)


@router.get("/samples")
async def samples():
    return SAMPLES


@router.post("")
async def ask(req: AskRequest, request: Request):
    limiter.check(request)  # raises 429 if over the per-IP limit

    question = (req.question or "").strip()
    if not question:
        return {"ok": False, "stage": "input", "error": "Ask a question."}

    started = time.monotonic()

    # 1. generate
    try:
        raw_sql = await generate_sql(question)
    except Exception as e:  # provider/auth/network issues surface cleanly
        log.warning("generate failed: %s", e)
        return {"ok": False, "stage": "generate", "error": str(e)}

    # 2. validate (guardrails)
    ok, msg, sql = validate_sql(raw_sql)
    if not ok:
        log.info("guardrail rejected (%s): %r", msg, raw_sql)
        return {
            "ok": False, "stage": "guardrail", "error": msg,
            "sql": raw_sql, "guardrail": "rejected",
        }

    # 3. execute (read-only). One self-correction retry if the DB rejects it.
    repaired = False
    try:
        columns, rows = await run_readonly(sql)
    except Exception as e:
        db_error = str(e)
        log.info("execute failed, attempting one repair: %s", db_error)
        fixed = await _try_repair(question, sql, db_error)
        if fixed is None:
            return {
                "ok": False, "stage": "execute", "error": db_error,
                "sql": sql, "guardrail": "passed (read-only, validated)",
            }
        if not fixed["ok"]:
            return fixed["payload"]
        sql, columns, rows, repaired = fixed["sql"], fixed["columns"], fixed["rows"], True

    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "answered q=%r rows=%d repaired=%s in %dms", question[:80], len(rows),
        repaired, elapsed_ms,
    )
    return {
        "ok": True,
        "question": question,
        "sql": sql,
        "repaired": repaired,
        "guardrail": "passed (read-only, validated, single-statement)",
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "viz": viz_hint(columns, rows),
    }


async def _try_repair(question: str, bad_sql: str, db_error: str):
    """Run one self-correction round. Returns:
      None                          -> repair unavailable / model errored
      {'ok': False, 'payload': ...} -> repaired SQL still failed (guardrail/DB)
      {'ok': True, 'sql', 'columns', 'rows'} -> repaired and executed
    """
    try:
        raw = await repair_sql(question, bad_sql, db_error)
    except Exception as e:
        log.warning("repair generation failed: %s", e)
        return None

    ok, msg, sql = validate_sql(raw)
    if not ok:
        log.info("repaired query rejected by guardrails: %s", msg)
        return {"ok": False, "payload": {
            "ok": False, "stage": "guardrail", "error": msg,
            "sql": raw, "guardrail": "rejected", "repaired": True,
        }}
    try:
        columns, rows = await run_readonly(sql)
    except Exception as e:
        log.info("repaired query still failed: %s", e)
        return {"ok": False, "payload": {
            "ok": False, "stage": "execute", "error": str(e),
            "sql": sql, "guardrail": "passed (read-only, validated)",
            "repaired": True,
        }}
    return {"ok": True, "sql": sql, "columns": columns, "rows": rows}
