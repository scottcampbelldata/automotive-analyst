"""The fixed-window limiter protects the public /run endpoint."""
import pytest
from fastapi import HTTPException

from app.ratelimit import FixedWindowLimiter


class FakeClient:
    def __init__(self, host):
        self.host = host


class FakeRequest:
    def __init__(self, xff=None, host="127.0.0.1"):
        self.headers = {"x-forwarded-for": xff} if xff else {}
        self.client = FakeClient(host)


def test_allows_up_to_the_limit_then_blocks():
    limiter = FixedWindowLimiter(max_requests=2, window_seconds=60)
    req = FakeRequest(host="1.2.3.4")
    limiter.check(req)  # 1
    limiter.check(req)  # 2
    with pytest.raises(HTTPException) as exc:
        limiter.check(req)  # 3 -> over
    assert exc.value.status_code == 429
    assert "Retry-After" in exc.value.headers


def test_different_clients_have_separate_buckets():
    limiter = FixedWindowLimiter(max_requests=1, window_seconds=60)
    limiter.check(FakeRequest(host="1.1.1.1"))
    # a different IP is unaffected by the first client's usage
    limiter.check(FakeRequest(host="2.2.2.2"))


def test_uses_forwarded_for_behind_proxy():
    limiter = FixedWindowLimiter(max_requests=1, window_seconds=60)
    # same socket peer (nginx), different real clients via X-Forwarded-For
    limiter.check(FakeRequest(xff="9.9.9.9", host="127.0.0.1"))
    limiter.check(FakeRequest(xff="8.8.8.8", host="127.0.0.1"))
    with pytest.raises(HTTPException):
        limiter.check(FakeRequest(xff="9.9.9.9", host="127.0.0.1"))
