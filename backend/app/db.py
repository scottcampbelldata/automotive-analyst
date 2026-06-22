"""asyncpg pool to the existing dashboard database + JSON-safe helpers."""
from decimal import Decimal
from datetime import datetime, date
import asyncpg

from .config import DATABASE_URL

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=6)


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _clean(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


async def fetch_one(sql: str, *args) -> dict | None:
    assert _pool is not None, "pool not initialized"
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    return {k: _clean(v) for k, v in row.items()} if row else None
