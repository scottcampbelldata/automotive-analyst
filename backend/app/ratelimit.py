"""
A small, dependency-free fixed-window rate limiter.

`/api/ask` calls a paid LLM and then the database on every request, so a public,
unauthenticated endpoint needs a throttle or it's an open invitation to run up an
API bill. This keeps it self-contained and unit-testable rather than pulling in a
heavier dependency.

Note on the client key: the API runs behind nginx, so request.client.host is
127.0.0.1 for everyone. We key on the first hop of X-Forwarded-For (set by nginx)
and fall back to the socket peer for direct/local connections.
"""
import time
from collections import deque

from fastapi import HTTPException, Request


class FixedWindowLimiter:
    def __init__(self, max_requests: int, window_seconds: float):
        self.max = max_requests
        self.window = window_seconds
        self._hits: dict[str, deque] = {}

    @staticmethod
    def client_key(request: Request) -> str:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def check(self, request: Request) -> None:
        """Record a hit; raise HTTP 429 if the caller is over the limit."""
        now = time.monotonic()
        key = self.client_key(request)
        dq = self._hits.setdefault(key, deque())
        while dq and now - dq[0] > self.window:
            dq.popleft()
        if len(dq) >= self.max:
            retry = int(self.window - (now - dq[0])) + 1
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded - slow down and retry in ~{retry}s.",
                headers={"Retry-After": str(retry)},
            )
        dq.append(now)
