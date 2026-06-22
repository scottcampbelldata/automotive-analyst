# Automotive Analyst — bring-your-own-key text-to-SQL agent

Ask an automotive final-assembly plant's data warehouse a question in plain
English — *"which station lost the most hours on D-crew last quarter?"* — and your
own LLM writes the PostgreSQL, the server validates it through read-only
guardrails, runs it, and returns the answer **with the query shown**.

It reads the same warehouse that powers the
[factory dashboard](https://factory.scottcampbell.io), read-only.

<!-- After pushing, set OWNER to your GitHub user/org for the badge to render. -->
![CI](https://github.com/OWNER/automotive-analyst/actions/workflows/ci.yml/badge.svg)

**Live:** https://analyst.scottcampbell.io  ·  **API:** https://analyst-api.scottcampbell.io

> Companion to the **Manufacturing Intelligence dashboard**, but a fully separate
> project. Data is synthetic; no proprietary or employer data.

---

## The interesting part: bring-your-own-key, key never touches the server

Visitors use **their own** Claude, OpenAI, or Gemini API key. The key is held only
in the browser tab's `sessionStorage` (wiped on close) and is sent **directly** to
the chosen provider — it never reaches this site's backend. Open DevTools and
you'll see the key go only to `api.anthropic.com` / `api.openai.com` / Google.

That means the backend has **no LLM secret at all**. Its only job is to be a
**fail-safe SQL gateway**: it serves the schema grounding, then accepts SQL and
runs it safely. Accepting client-supplied SQL is fine *by design* — that's exactly
what the guardrails and the read-only database role are for.

## Layered safety (the senior signal)

Letting an LLM write SQL against a real database is where naive implementations
get dangerous. The safety model is defense-in-depth:

1. **Application guardrails** ([`guardrails.py`](backend/app/agent/guardrails.py)) —
   single statement only (no `;` chaining), `SELECT`/`WITH` only, no DDL/admin
   keywords, a blanket ban on `pg_*`, a table/view **allow-list** (fail-closed),
   no `SELECT … INTO`, SQL comments stripped before checks, and a `LIMIT` injected
   if missing.
2. **Database enforcement** — a dedicated **read-only role** (`factory_ro`) inside a
   `READ ONLY` transaction with a statement timeout. Even SQL that somehow slipped
   the app layer cannot write or hang the box.
3. **Abuse limits** — per-IP rate limiting (correct behind nginx via
   `X-Forwarded-For`) and request size caps on the public endpoint.
4. **Transparency** — every response returns the exact SQL and the guardrail
   verdict. If the DB rejects a query, the model gets one self-correction round.

The guardrails ship with a test suite covering real attacks — statement chaining,
`DELETE`/`DROP`, `pg_read_file`, `pg_user`, `information_schema`, `COPY`
exfiltration, comment obfuscation, and substring traps (`created_at` must *not*
trip the write-keyword filter). Writing those tests is what caught a real
`pg_read_file` bypass during development.

## Architecture

```
                         ┌─────────────── browser (visitor's key, sessionStorage) ───────────────┐
question ─▶ schema ctx ─▶│  generate SQL  ──key──▶  Claude / OpenAI / Gemini  ──▶  SQL text       │
   ▲        (from API)   └──────────────────────────────────┬─────────────────────────────────────┘
   │                                                         ▼  POST { question, sql }
   │                          ┌──────────────────── backend (VPS, no LLM key) ─────────────────────┐
   └── answer + SQL ◀─────────│  guardrails ──▶ read-only execute (factory_ro, RO txn, timeout)     │
                              └────────────────────────────────────────────────────────────────────┘
```

| Layer    | Stack                                    | Hosting             |
|----------|------------------------------------------|---------------------|
| Frontend | Next.js (static export), Recharts        | Cloudflare Pages    |
| Backend  | FastAPI, asyncpg                         | VPS + nginx + TLS   |
| Database | PostgreSQL (shared with the dashboard)   | VPS, read-only role |
| LLM      | Claude / OpenAI / Gemini — visitor's key | in the browser      |

## Repository layout

```
backend/
  app/
    agent/
      schema_context.py   # star-schema prompt + few-shot examples (served to the browser)
      guardrails.py       # read-only SQL validation (the security-critical layer)
      runner.py           # read-only execution + viz hint
    routers/ask.py        # /samples, /context, /run  (no LLM, no key)
    ratelimit.py          # per-IP fixed-window limiter (X-Forwarded-For aware)
    config.py  db.py  main.py
  tests/                  # 55 tests: guardrails, ratelimit, viz, API flow
frontend/
  lib/keyStore.ts         # session-only BYOK storage
  lib/providers.ts        # Claude / OpenAI / Gemini abstraction (client-side generation)
  lib/api.ts
  components/KeyPanel.tsx  # provider + key entry
  app/page.tsx            # ask UI: live SQL, chart/KPI/table, self-correct badge
deploy/
  RUNBOOK.md  analyst-api.service  nginx.conf
.github/workflows/ci.yml  # backend lint+tests, frontend build
```

## Run locally

**Backend** (needs the dashboard's Postgres reachable + a read-only role; no LLM key):
```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # ".venv/bin/pip" on macOS/Linux
cp .env.example .env   # set DATABASE_URL to the factory_ro role
.venv/Scripts/uvicorn app.main:app --reload --port 8010
pytest && ruff check app tests
```

**Frontend:**
```bash
cd frontend
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8010 npm run dev   # http://localhost:3010
```
Open the app, pick a provider, paste your own API key, and ask a question.

Deployment (read-only role, systemd, nginx + TLS, Cloudflare Pages) is in
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).

## What to say about it in an interview

- *Trust boundary:* "The backend never holds anyone's key and safely executes even
  untrusted SQL, because the allow-list guardrails plus a read-only role make the
  data store fail-safe."
- *Provider abstraction:* one interface over three LLMs' differing request/response
  shapes, swappable at runtime.
- *Tested security:* the guardrail allow-list is covered by attack-case tests in CI.
