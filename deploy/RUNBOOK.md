# Deployment Runbook — Automotive Analyst

Backend (SQL gateway API) runs on the VPS; frontend is static on Cloudflare
Pages. The agent reads the **existing dashboard database** read-only — it does
not create or load any data. **There is no LLM API key on the server**: visitors
bring their own key in the browser, so the server's only secret is the read-only
database connection.

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

This is the second line of defense — even if a client-supplied query slipped past
the app-level guardrails, the role cannot write.

## 2. Backend on the VPS
```bash
sudo mkdir -p /opt/automotive-analyst && sudo chown $USER /opt/automotive-analyst
# copy the repo (rsync or git clone) to /opt/automotive-analyst
cd /opt/automotive-analyst/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# quick test (only the DB role is needed — no LLM key):
DATABASE_URL="postgresql://factory_ro:STRONG_PASSWORD@localhost:5432/manufacturing" \
.venv/bin/uvicorn app.main:app --port 8010
# curl -s localhost:8010/api/ask/samples
# curl -s localhost:8010/api/ask/context | head -c 200
# curl -s -X POST localhost:8010/api/ask/run -H 'content-type: application/json' \
#   -d '{"question":"oee","sql":"SELECT * FROM v_oee"}'
```

Install the service (edit env in the unit first — DB role + CORS origin):
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
The rate limiter keys on `X-Forwarded-For`, which nginx sets in `nginx.conf` — keep
that header in place so per-client limits work correctly behind the proxy.

## 4. Frontend on Cloudflare Pages
The frontend is a static Next.js export (`output: "export"`).
- Create a Cloudflare Pages project from this repo, root directory `frontend`.
- Build command: `npm run build`  ·  Output directory: `out`
- Environment variable: `NEXT_PUBLIC_API_BASE = https://analyst-api.scottcampbell.io`
- Add the custom domain `analyst.scottcampbell.io` in the Pages project.

CORS on the API already allows `https://analyst.scottcampbell.io` (set in the
systemd unit). Done — open https://analyst.scottcampbell.io, pick a provider, paste
your own API key, and ask a question.

---

## LLM providers (bring-your-own-key)
Generation happens in the browser with the visitor's key — nothing to configure on
the server. The frontend supports **Claude, OpenAI, and Gemini**; the provider
abstraction lives in `frontend/lib/providers.ts`. The key is kept in the tab's
`sessionStorage` and sent directly to the provider, never to this API.

## Safety model (what to say in an interview)
1. App guardrails: single statement, SELECT/WITH only, no DDL/admin keywords,
   blanket `pg_*` ban, table/view allow-list (fail-closed), comments stripped,
   injected LIMIT. Covered by attack-case tests in CI.
2. DB enforcement: dedicated read-only role + read-only transaction + statement
   timeout — safe even though `/run` accepts client-supplied SQL.
3. Abuse limits: per-IP rate limiting + request size caps.
4. Transparency: every answer returns the exact SQL that ran; one self-correction
   round on a database error.
```
