"""
Text-to-SQL agent endpoint (Project 2).

Flow:  question -> LLM generates SQL -> guardrails validate -> read-only execute
Every response returns the generated SQL (transparency) and the guardrail status,
so the user always sees the query behind the answer.
"""
from fastapi import APIRouter
from pydantic import BaseModel

from ..agent.generate import generate_sql
from ..agent.guardrails import validate_sql
from ..agent.runner import run_readonly, viz_hint

router = APIRouter(prefix="/api/ask", tags=["agent"])

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
    question: str


@router.get("/samples")
async def samples():
    return SAMPLES


@router.post("")
async def ask(req: AskRequest):
    question = (req.question or "").strip()
    if not question:
        return {"ok": False, "stage": "input", "error": "Ask a question."}

    # 1. generate
    try:
        raw_sql = await generate_sql(question)
    except Exception as e:  # provider/auth/network issues surface cleanly
        return {"ok": False, "stage": "generate", "error": str(e)}

    # 2. validate (guardrails)
    ok, msg, sql = validate_sql(raw_sql)
    if not ok:
        return {
            "ok": False, "stage": "guardrail", "error": msg,
            "sql": raw_sql, "guardrail": "rejected",
        }

    # 3. execute (read-only). One repair retry if the DB rejects the SQL.
    try:
        columns, rows = await run_readonly(sql)
    except Exception as e:
        return {
            "ok": False, "stage": "execute", "error": str(e),
            "sql": sql, "guardrail": "passed (read-only, validated)",
        }

    return {
        "ok": True,
        "question": question,
        "sql": sql,
        "guardrail": "passed (read-only, validated, single-statement)",
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "viz": viz_hint(columns, rows),
    }
