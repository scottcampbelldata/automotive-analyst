# Deployment Runbook — Automotive Analyst

Backend (SQL gateway API) runs on the VPS alongside the other portfolio APIs;
frontend is static on Cloudflare Pages. The agent reads the **existing dashboard
database** (`manufacturing`) read-only — it does not create or load any data.
**There is no LLM API key on the server**: visitors bring their own key in the
browser, so the server's only secret is the read-only database connection.

| Piece    | Where            | Address / detail                          |
|----------|------------------|-------------------------------------------|
| Frontend | Cloudflare Pages | https://analyst.scottcampbell.io          |
| API      | VPS + nginx      | https://analyst-api.scottcampbell.io → 127.0.0.1:8010 |
| Database | VPS Postgres     | `manufacturing`, read-only role `factory_ro` |
| VPS      | <your-vps-ip>    | `/opt/automotive-analyst`, user `deploy` |

Ports 8000/8001/8002/8787 are taken by other apps; this API uses **8010**.

---

## 0. Get the code onto the VPS (no sudo)
```bash
cd /opt
git clone https://github.com/scottcampbelldata/automotive-analyst.git
cd automotive-analyst/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 1. Create the READ-ONLY database role (sudo)
The agent must never write. Create a dedicated read-only role on the same
Postgres that powers the dashboard, and grant it SELECT on the existing objects:
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

## 2. Backend env (no sudo)
Create `/opt/automotive-analyst/backend/.env` (git-ignored), using the same
password as the role above:
```bash
umask 077
cat > /opt/automotive-analyst/backend/.env <<'ENV'
DATABASE_URL=postgresql://factory_ro:STRONG_PASSWORD@localhost:5432/manufacturing
CORS_ORIGINS=https://analyst.scottcampbell.io,https://automotive-analyst.pages.dev,http://localhost:3000
ENV
```
Quick foreground test (only the DB role is needed — no LLM key):
```bash
cd /opt/automotive-analyst/backend
set -a; source .env; set +a
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010
# in another shell:
curl -s localhost:8010/health
curl -s -X POST localhost:8010/api/ask/run -H 'content-type: application/json' \
  -d '{"question":"oee","sql":"SELECT * FROM v_oee"}'
```

## 3. Install the service (sudo)
```bash
cd /opt/automotive-analyst
sudo cp deploy/analyst-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now analyst-api
journalctl -u analyst-api -n 20 --no-pager
```

## 4. nginx + TLS (sudo)
Point DNS `analyst-api.scottcampbell.io` → `<your-vps-ip>` first, then:
```bash
cd /opt/automotive-analyst
sudo cp deploy/nginx.conf /etc/nginx/sites-available/analyst-api.scottcampbell.io.conf
sudo ln -s /etc/nginx/sites-available/analyst-api.scottcampbell.io.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d analyst-api.scottcampbell.io
curl -s https://analyst-api.scottcampbell.io/health
```
The rate limiter keys on `X-Forwarded-For`, which nginx sets — keep that header.

## 5. Frontend on Cloudflare Pages
Static Next.js export (`output: "export"`).
- New Pages project from `scottcampbelldata/automotive-analyst`, root directory `frontend`.
- Build command `npm run build` · output directory `out`.
- Env var `NEXT_PUBLIC_API_BASE = https://analyst-api.scottcampbell.io`.
- Add custom domain `analyst.scottcampbell.io`.

CORS already allows `analyst.scottcampbell.io` and the `*.pages.dev` preview.

## Updating
```bash
cd /opt/automotive-analyst && git pull --ff-only
sudo systemctl restart analyst-api
```

## Safety model
1. App guardrails: single statement, SELECT/WITH only, no DDL/admin keywords,
   blanket `pg_*` ban, info-leak function denylist, table/view allow-list
   (fail-closed), comments stripped, injected LIMIT. Attack-case tests in CI.
2. DB enforcement: dedicated read-only role + read-only transaction + statement
   timeout — safe even though `/run` accepts client-supplied SQL.
3. Abuse limits: per-IP rate limiting + request size caps.
4. Transparency: every answer returns the exact SQL that ran; one self-correction
   round on a database error.
