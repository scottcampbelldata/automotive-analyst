"""
Locks in how run_readonly talks to the database: it must run inside a READ-ONLY
transaction and scope the statement timeout with SET LOCAL (so it can't leak onto
the next borrower of a pooled connection). The asyncpg connection is faked.
"""
from app import db
from app.agent import runner


class FakeTx:
    def __init__(self, conn, readonly):
        self.conn, self.readonly = conn, readonly

    async def __aenter__(self):
        self.conn.calls.append(("tx_enter", self.readonly))

    async def __aexit__(self, *exc):
        self.conn.calls.append(("tx_exit", None))
        return False


class FakeConn:
    def __init__(self, rows):
        self.calls = []
        self._rows = rows

    async def execute(self, sql):
        self.calls.append(("execute", sql))

    def transaction(self, *, readonly=False):
        return FakeTx(self, readonly)

    async def fetch(self, sql):
        self.calls.append(("fetch", sql))
        return self._rows


class FakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc):
        return False


class FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return FakeAcquire(self.conn)


async def test_run_readonly_uses_set_local_inside_readonly_transaction(monkeypatch):
    conn = FakeConn([{"station": "ST03", "hours": 40}])
    monkeypatch.setattr(db, "_pool", FakePool(conn))

    cols, rows = await runner.run_readonly("SELECT 1", timeout_ms=5000)

    assert cols == ["station", "hours"]
    assert rows == [{"station": "ST03", "hours": 40}]

    kinds = [c[0] for c in conn.calls]
    # read-only transaction was opened
    assert ("tx_enter", True) in conn.calls
    # the timeout was set with SET LOCAL (transaction-scoped), not a session SET
    set_stmts = [sql for kind, sql in conn.calls if kind == "execute"]
    assert any("SET LOCAL" in s.upper() and "STATEMENT_TIMEOUT" in s.upper() for s in set_stmts)
    # ordering: enter tx -> SET LOCAL -> fetch
    assert kinds.index("tx_enter") < kinds.index("execute") < kinds.index("fetch")


async def test_run_readonly_returns_empty_for_no_rows(monkeypatch):
    conn = FakeConn([])
    monkeypatch.setattr(db, "_pool", FakePool(conn))
    cols, rows = await runner.run_readonly("SELECT 1")
    assert cols == [] and rows == []
