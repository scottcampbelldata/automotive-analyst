"""
A small, dependency-free fixed-window rate limiter.

The public /run endpoint executes client-supplied SQL against the database on
every request, so it needs a throttle. This keeps it self-contained and
unit-testable rather than pulling in a heavier dependency.

Note on the client key: the API runs behind nginx, so request.client.host is
127.0.0.1 for everyone, and the real caller has to come from a proxy header.
Which header matters. nginx sets X-Real-IP from $remote_addr and OVERWRITES
anything the client sent, so it is trustworthy. X-Forwarded-For is not: the
common `$proxy_add_x_forwarded_for` form *appends* to the client-supplied value,
so its FIRST hop is attacker-controlled - keying on it let anyone reset their own
bucket by rotating the header, defeating the limiter entirely. We prefer
X-Real-IP, fall back to the LAST X-Forwarded-For hop (the one the proxy itself
appended), and finally to the socket peer.

Note on process count: these buckets live in this process only. Run a single
uvicorn worker, or the effective limit is multiplied by the worker count.

Memory is bounded: client buckets are held in an LRU map capped at max_clients,
so a flood of distinct IPs (or spoofed X-Forwarded-For values) can't grow it
without limit.
"""
import time
from collections import OrderedDict, deque

from fastapi import HTTPException, Request


class FixedWindowLimiter:
    def __init__(self, max_requests: int, window_seconds: float, max_clients: int = 50_000):
        self.max = max_requests
        self.window = window_seconds
        self.max_clients = max_clients
        self._hits: OrderedDict[str, deque] = OrderedDict()

    @staticmethod
    def client_key(request: Request) -> str:
        real = request.headers.get("x-real-ip")
        if real and real.strip():
            return real.strip()
        xff = request.headers.get("x-forwarded-for")
        if xff:
            # LAST hop, not first: everything before it was supplied by the caller.
            hops = [h.strip() for h in xff.split(",") if h.strip()]
            if hops:
                return hops[-1]
        return request.client.host if request.client else "unknown"

    def check(self, request: Request) -> None:
        """Record a hit; raise HTTP 429 if the caller is over the limit."""
        now = time.monotonic()
        key = self.client_key(request)

        dq = self._hits.get(key)
        if dq is None:
            dq = deque()
            self._hits[key] = dq
        self._hits.move_to_end(key)  # mark most-recently-used

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

        # bound memory: evict the least-recently-used idle clients
        while len(self._hits) > self.max_clients:
            self._hits.popitem(last=False)
