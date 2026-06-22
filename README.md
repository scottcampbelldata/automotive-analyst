# Automotive Analyst — natural-language analytics agent

A text-to-SQL agent that answers plain-English questions about an automotive
final-assembly plant by writing, validating, and running PostgreSQL against the
same warehouse that powers the [factory dashboard](https://factory.scottcampbell.io).
Every answer shows the exact query behind it.

**Live:** https://analyst.scottcampbell.io  ·  **API:** https://analyst-api.scottcampbell.io

> Companion to the [Manufacturing Intelligence dashboard](https://factory.scottcampbell.io).
> The two are independent projects that read the **same** Postgres warehouse —
> the dashboard with a read/write app role, the analyst with a dedicated
> **read-only** role. Data is fully synthetic; no proprietary or employer data.

---

## What it does

Ask `"Which station lost the most downtime hours on the night crew?"` and the
agent grounds the question in the star schema, generates a single PostgreSQL
`SELECT`, runs it through read-only guardrails, executes it as a read-only role,
and renders the result as a chart, KPI, or table — alongside the SQL it ran.

## Why it's built this way

Letting an LLM write SQL against a real database is exactly where naive
implementations get dangerous. The safety model is layered, defense-in-depth:

1. **Application guardrails** ([`guardrails.py`](backend/app/agent/guardrails.py)) —
   single statement only (no `;` chaining), `SELECT`/`WITH` only, no DDL/admin
   keywords, table/view **allow-list**, no `SELECT … INTO`, and a `LIMIT` is
   injected if the model omits one.
2. **Database enforcement** — a dedicated **read-only role** (`factory_ro`)
   running inside a `READ ONLY` transaction with a statement timeout. Even a
   query that somehow slipped the app layer cannot write or hang the box.
3. **Transparency** — the generated SQL and guardrail verdict are returned on
   every response, so the answer is never a black box.

The guardrail layer is covered by attack-case checks (statement chaining,
`DELETE`/`DROP`, `pg_*` admin functions, `SELECT INTO`, `COPY` exfiltration,
`pg_sleep` DoS, and substring traps like `created_at` that must *not* trip the
write-keyword filter).

## Architecture

```
question ─▶ schema grounding ─▶ LLM generates SQL ─▶ guardrails ─▶ read-only exec ─▶ result + SQL
           (star schema +        (Anthropic API,      (allow-list,   (factory_ro role,
            few-shot examples)     Ollama-swappable)    SELECT-only)   RO txn + timeout)
```

| Layer    | Stack                                   | Hosting          |
|----------|-----------------------------------------|------------------|
| Frontend | Next.js (static export), Recharts       | Cloudflare Pages |
| Backend  | FastAPI, asyncpg, httpx                 | VPS + nginx + TLS |
| Database | PostgreSQL (shared with the dashboard)  | VPS, read-only role |
| LLM      | Anthropic API (default) or local Ollama | swappable via env |

## Repository layout

```
backend/
  app/
    agent/
      schema_context.py   # star-schema prompt + few-shot examples (the grounding)
      generate.py         # NL -> SQL; Anthropic default, Ollama-swappable
      guardrails.py       # read-only validation (the security-critical layer)
      runner.py           # read-only execution + viz hint
    routers/ask.py        # /api/ask — generate -> guardrail -> execute
    config.py  db.py  main.py
frontend/
  app/page.tsx            # ask UI: question, live SQL, chart/KPI/table result
  lib/api.ts
deploy/
  RUNBOOK.md              # role creation, systemd, nginx, Cloudflare Pages
  analyst-api.service  nginx.conf
```

## Run locally

**Backend** (needs the dashboard's Postgres reachable, and a read-only role):
```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # set DATABASE_URL (factory_ro) and ANTHROPIC_API_KEY
.venv/bin/uvicorn app.main:app --reload --port 8010
```

**Frontend:**
```bash
cd frontend
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8010 npm run dev   # http://localhost:3010
```

Deployment (read-only role, systemd, nginx + TLS, Cloudflare Pages) is in
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).

## LLM provider

Defaults to the Anthropic API. To run fully local, set `AGENT_PROVIDER=ollama`
with `OLLAMA_BASE` / `OLLAMA_MODEL` (e.g. a `sqlcoder` model) — no code change.
