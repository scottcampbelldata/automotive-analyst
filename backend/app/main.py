"""
Automotive Analyst -- FastAPI backend (Project 2).

A text-to-SQL analytics agent over the existing dashboard database. Natural
language -> schema-grounded PostgreSQL -> read-only guardrails -> execution.
Runs on the VPS behind nginx at analyst-api.scottcampbell.io.

Run (dev):  uvicorn app.main:app --reload --port 8010
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .config import CORS_ORIGINS
from .routers import ask


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()


app = FastAPI(
    title="Automotive Analyst",
    version="1.0.0",
    description="Natural-language analytics over the automotive assembly warehouse.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(ask.router)


@app.get("/health")
async def health():
    row = await db.fetch_one("SELECT 1 AS ok")
    return {"status": "ok", "db": bool(row and row["ok"] == 1)}
