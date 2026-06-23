"""
Shared fixtures. The API tests run the real FastAPI app through Starlette's
TestClient but with the database mocked out - no Postgres needed in CI. The
guardrails and routing are exercised for real; only the DB boundary is faked.
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    from app import db

    async def fake_connect():
        db._pool = object()  # non-None sentinel so route asserts pass

    async def fake_disconnect():
        db._pool = None

    async def fake_fetch_one(sql, *args):
        return {"ok": 1}

    monkeypatch.setattr(db, "connect", fake_connect)
    monkeypatch.setattr(db, "disconnect", fake_disconnect)
    monkeypatch.setattr(db, "fetch_one", fake_fetch_one)

    from app.main import app
    from app.routers import ask

    # reset the module-level limiter so test order can't trip the rate limit
    ask.limiter._hits.clear()

    with TestClient(app) as c:
        c._ask = ask  # expose for per-test monkeypatching of run_readonly
        yield c
