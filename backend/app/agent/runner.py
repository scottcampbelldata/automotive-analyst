"""
Execute validated SQL under a READ-ONLY transaction with a statement timeout.
Even though guardrails.py already rejects writes, the database itself enforces
read-only here as a second line of defense.
"""
from .. import db
from ..config import QUERY_TIMEOUT_MS


async def run_readonly(sql: str, timeout_ms: int = QUERY_TIMEOUT_MS):
    """Run sql in a read-only transaction. Returns (columns, rows)."""
    assert db._pool is not None, "pool not initialized"
    async with db._pool.acquire() as conn:
        # SET LOCAL keeps the timeout scoped to this transaction so it resets on
        # commit and never bleeds onto the next borrower of this pooled connection.
        async with conn.transaction(readonly=True):
            await conn.execute(f"SET LOCAL statement_timeout = {int(timeout_ms)}")
            records = await conn.fetch(sql)
    if not records:
        return [], []
    columns = list(records[0].keys())
    rows = [
        {k: db._clean(v) for k, v in r.items()}
        for r in records
    ]
    return columns, rows


def viz_hint(columns, rows):
    """Suggest how the frontend should render the result."""
    if not rows or not columns:
        return "empty"
    if len(rows) == 1 and len(columns) <= 4:
        return "scalar"
    # time series if a date/month/quarter-like column is present
    lower = [c.lower() for c in columns]
    if any(k in c for c in lower for k in ("month", "quarter", "qtr", "date", "ts", "yr", "year")):
        return "line"
    # one label + one number -> bar
    if len(columns) == 2 and isinstance(rows[0][columns[1]], (int, float)):
        return "bar"
    return "table"
