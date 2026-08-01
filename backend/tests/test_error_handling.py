"""
Execute-stage error handling on /api/ask/run.

Two audit findings are covered here:
  - raw asyncpg exception text (DETAIL / HINT / CONTEXT / LINE n) was returned
    verbatim to unauthenticated callers;
  - a saturated connection pool made requests wait forever, because asyncpg's
    acquire() defaults to no timeout. It now surfaces as a 503.
"""
import pytest

from app.routers.ask import MAX_ERROR_CHARS, _safe_db_error


def test_safe_db_error_keeps_the_useful_first_line():
    e = Exception('column "widget" does not exist')
    assert _safe_db_error(e) == 'column "widget" does not exist'


@pytest.mark.parametrize("noise", ["DETAIL", "HINT", "CONTEXT", "QUERY", "STATEMENT"])
def test_safe_db_error_strips_server_internals(noise):
    e = Exception(f'syntax error at or near ")"\n{noise}:  /opt/app/internal.py:412 as role factory_ro')
    out = _safe_db_error(e)
    assert out == 'syntax error at or near ")"'
    assert "internal.py" not in out and "factory_ro" not in out


def test_safe_db_error_strips_line_positions():
    e = Exception('syntax error\nLINE 1: SELECT * FROM ...\n        ^')
    assert _safe_db_error(e) == "syntax error"


def test_safe_db_error_is_length_capped():
    assert len(_safe_db_error(Exception("x" * 5000))) <= MAX_ERROR_CHARS


def test_safe_db_error_never_returns_empty():
    assert _safe_db_error(Exception("")) == "the query could not be executed"


def test_pool_exhaustion_returns_503(client):
    async def busy_pool(sql, timeout_ms=None):
        raise TimeoutError

    client._ask.limiter._hits.clear()
    import app.routers.ask as ask_mod

    original = ask_mod.run_readonly
    ask_mod.run_readonly = busy_pool
    try:
        r = client.post("/api/ask/run", json={"question": "q", "sql": "SELECT * FROM v_oee"})
        assert r.status_code == 503
        assert "busy" in r.json()["detail"].lower()
        assert r.headers.get("Retry-After") == "5"
    finally:
        ask_mod.run_readonly = original


def test_execute_error_is_sanitized_end_to_end(client):
    async def boom(sql, timeout_ms=None):
        raise Exception('column "nope" does not exist\nHINT:  internal detail here')

    client._ask.limiter._hits.clear()
    import app.routers.ask as ask_mod

    original = ask_mod.run_readonly
    ask_mod.run_readonly = boom
    try:
        r = client.post("/api/ask/run", json={"question": "q", "sql": "SELECT * FROM v_oee"})
        body = r.json()
        assert body["ok"] is False and body["stage"] == "execute"
        assert body["error"] == 'column "nope" does not exist'
        assert "internal detail" not in body["error"]
    finally:
        ask_mod.run_readonly = original
