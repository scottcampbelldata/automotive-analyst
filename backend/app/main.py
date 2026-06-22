"""
Automotive Analyst -- FastAPI backend (Project 2).

A bring-your-own-key text-to-SQL analytics gateway over the existing dashboard
database. The browser generates SQL (Claude / OpenAI / Gemini, visitor's key);
this service grounds it with the schema, then validates and runs it read-only.
It holds no LLM key -- only a read-only database connection.
Runs on the VPS behind nginx at analyst-api.scottcampbell.io.

Run (dev):  uvicorn app.main:app --reload --port 8010
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .config import CORS_ORIGINS, LOG_LEVEL
from .routers import ask

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()


app = FastAPI(
    title="Automotive Analyst",
    version="1.0.0",
    description="Bring-your-own-key natural-language analytics over the automotive assembly warehouse.",
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
