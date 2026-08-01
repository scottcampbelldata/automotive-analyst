"""
Execute validated SQL under a READ-ONLY transaction with a statement timeout.
Even though guardrails.py already rejects writes, the database itself enforces
read-only here as a second line of defense.
"""
from .. import db
from ..config import POOL_ACQUIRE_TIMEOUT_S, QUERY_TIMEOUT_MS


async def run_readonly(sql: str, timeout_ms: int = QUERY_TIMEOUT_MS):
    """Run sql in a read-only transaction. Returns (columns, rows).

    The acquire is bounded: the pool holds only a handful of connections and each
    query may occupy one for the full statement timeout, so an unbounded wait let
    a burst of slow queries stall every later request. TimeoutError surfaces to
    the caller as a 503 rather than a hung request.
    """
    assert db._pool is not None, "pool not initialized"
    async with db._pool.acquire(timeout=POOL_ACQUIRE_TIMEOUT_S) as conn:
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
