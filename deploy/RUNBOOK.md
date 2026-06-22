# Deployment Runbook — Automotive Analyst

Backend (text-to-SQL API) runs on the VPS; frontend is static on Cloudflare
Pages. The agent reads the **existing dashboard database** read-only — it does
not create or load any data.

| Piece    | Where            | Address                          |
|----------|------------------|----------------------------------|
| Frontend | Cloudflare Pages | https://analyst.scottcampbell.io |
| API      | VPS + nginx      | https://analyst-api.scottcampbell.io |
| Database | VPS (shared)     | the dashboard's Postgres, read-only role |

---

## 1. Create a READ-ONLY database role (one time)
The agent must never write. Create a dedicated read-only role on the same
Postgres that powers the dashboard:

```bash
sudo -u postgres psql -d manufacturing <<'SQL'
CREATE ROLE factory_ro LOGIN PASSWORD 'STRONG_PASSWORD';
GRANT CONNECT ON DATABASE manufacturing TO factory_ro;
GRANT USAGE ON SCHEMA public TO factory_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO factory_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO factory_ro;
SQL
```

This is the second line of defense — even if a generated query slipped past the
app-level guardrails, the role cannot write.

## 2. Backend on the VPS
```bash
sudo mkdir -p /opt/automotive-analyst && sudo chown $USER /opt/automotive-analyst
# copy the repo (rsync or git clone) to /opt/automotive-analyst
cd /opt/automotive-analyst/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# quick test (set env inline):
DATABASE_URL="postgresql://factory_ro:STRONG_PASSWORD@localhost:5432/manufacturing" \
ANTHROPIC_API_KEY="sk-ant-..." \
.venv/bin/uvicorn app.main:app --port 8010
# curl -s localhost:8010/api/ask/samples
# curl -s -X POST localhost:8010/api/ask -H 'content-type: application/json' \
#   -d '{"question":"what is our overall OEE?"}'
```

Install the service (edit env in the unit first — DB role, Anthropic key, CORS):
```bash
sudo cp deploy/analyst-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now analyst-api
```

## 3. nginx + TLS for the API
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/analyst-api
sudo ln -s /etc/nginx/sites-available/analyst-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d analyst-api.scottcampbell.io
```

## 4. Frontend on Cloudflare Pages
The frontend is a static Next.js export (`output: "export"`).
- Create a Cloudflare Pages project from this repo, root directory `frontend`.
- Build command: `npm run build`  ·  Output directory: `out`
- Environment variable: `NEXT_PUBLIC_API_BASE = https://analyst-api.scottcampbell.io`
- Add the custom domain `analyst.scottcampbell.io` in the Pages project.

CORS on the API already allows `https://analyst.scottcampbell.io` (set in the
systemd unit). Done — open https://analyst.scottcampbell.io and ask a question.

---

## LLM provider
- Default is the Anthropic API (`AGENT_PROVIDER=anthropic`, set `ANTHROPIC_API_KEY`).
- To run fully local instead, set `AGENT_PROVIDER=ollama`, `OLLAMA_BASE`, and
  `OLLAMA_MODEL` (e.g. a `sqlcoder` model on the home server) — no code change.

## Safety model (what to say in an interview)
1. App guardrails: single statement, SELECT/WITH only, no DDL/admin keywords,
   table/view allow-list, injected LIMIT.
2. DB enforcement: dedicated read-only role + read-only transaction + statement
   timeout.
3. Transparency: every answer returns the exact SQL that ran.
