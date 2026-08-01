# Deployment Runbook - Automotive Analyst

Backend (SQL gateway API) runs on a VPS behind nginx; the frontend is static on
Cloudflare Pages. The agent reads an existing PostgreSQL warehouse **read-only**
- it does not create or load any data. **There is no LLM API key on the server**:
visitors bring their own key in the browser, so the server's only secret is the
read-only database connection.

| Piece    | Where            | Detail                                            |
|----------|------------------|---------------------------------------------------|
| Frontend | Cloudflare Pages | https://analyst.scottcampbell.io                  |
| API      | VPS + nginx      | https://analyst-api.scottcampbell.io → 127.0.0.1:8010 |
| Database | VPS PostgreSQL   | read-only role `factory_ro`                       |

Paths below are the **actual live deployment**, not a template: the checkout is
`/home/scott/automotive-analyst`, the service runs as `scott`, and the API binds
loopback port `8010`. Adjust if your host differs, but the commands here are
meant to work verbatim on this one. If a path ever looks wrong, trust the running
unit over this file:

```bash
systemctl show --no-pager analyst-api -p WorkingDirectory -p ExecStart -p User
```

---

## 0. Get the code onto the VPS
Lives in the service user's home, so no sudo and no chown:
```bash
git clone https://github.com/scottcampbelldata/automotive-analyst.git ~/automotive-analyst
cd ~/automotive-analyst/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 1. Create the READ-ONLY database role (sudo)
The agent must never write. Create a dedicated read-only role on the warehouse
and grant it SELECT on the existing objects:
```bash
sudo -u postgres psql -d manufacturing <<'SQL'
CREATE ROLE factory_ro LOGIN PASSWORD '<STRONG_PASSWORD>';
GRANT CONNECT ON DATABASE manufacturing TO factory_ro;
GRANT USAGE ON SCHEMA public TO factory_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO factory_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO factory_ro;
SQL
```
This is the second line of defense - even if a client-supplied query slipped past
the app-level guardrails, the role cannot write.

## 2. Backend env (no sudo)
Create `backend/.env` (git-ignored), substituting the same password as the role
above for `<STRONG_PASSWORD>`:
```bash
umask 077
cat > ~/automotive-analyst/backend/.env <<'ENV'
DATABASE_URL=postgresql://factory_ro:<STRONG_PASSWORD>@localhost:5432/manufacturing
CORS_ORIGINS=https://analyst.scottcampbell.io,https://automotive-analyst.pages.dev,http://localhost:3000
ENV
```
Quick foreground test (only the DB role is needed - no LLM key):
```bash
cd ~/automotive-analyst/backend
set -a; source .env; set +a
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010
# in another shell:
curl -s localhost:8010/health
curl -s -X POST localhost:8010/api/ask/run -H 'content-type: application/json' \
  -d '{"question":"oee","sql":"SELECT * FROM v_oee"}'
```

## 3. Install the service (sudo)
```bash
cd ~/automotive-analyst
sudo cp deploy/analyst-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now analyst-api
journalctl -u analyst-api -n 20 --no-pager
```
The unit runs **one** uvicorn worker on purpose. The rate limiter keeps its
buckets in process memory, so N workers would allow N x `RATE_LIMIT_MAX`.

If you ever edit the live unit in place rather than recopying it, re-check the
worker count afterwards:
```bash
systemctl show --no-pager analyst-api -p ExecStart | grep -o -- '--workers [0-9]'
```

## 4. nginx + TLS (sudo)
Point DNS `analyst-api.scottcampbell.io` at your VPS's IP first, then:
```bash
cd ~/automotive-analyst
sudo cp deploy/nginx.conf /etc/nginx/sites-available/analyst-api.scottcampbell.io.conf
sudo ln -s /etc/nginx/sites-available/analyst-api.scottcampbell.io.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d analyst-api.scottcampbell.io
curl -s https://analyst-api.scottcampbell.io/health
```

**Two things to know before re-copying this file over a live config.**

`certbot --nginx` rewrites the installed file, adding a `443` block and the TLS
directives. `deploy/nginx.conf` in the repo has none of that, so copying it over
a certbot-managed config drops HTTPS. After the first issuance, edit the live
file in place (or re-run certbot afterwards) rather than overwriting it.

Never write a backup **into** `sites-enabled/` - nginx includes the whole
directory, so `analyst-api...conf.bak` loads as a second server block and you get
`conflicting server name ... ignored`. Put backups somewhere nginx does not read.

The address headers are security-relevant. The rate limiter keys on the caller's
address, and it must not be forgeable, so nginx sets both `X-Real-IP` and
`X-Forwarded-For` to `$remote_addr`. Do **not** use `$proxy_add_x_forwarded_for`
here: it appends to whatever the client sent, leaving an attacker-controlled
first hop, and anyone could then reset their own bucket by rotating the header.
Verify with:
```bash
grep -n 'X-Forwarded-For\|X-Real-IP' /etc/nginx/sites-available/analyst-api.scottcampbell.io.conf
```

## 5. Frontend on Cloudflare Pages
Static Next.js export (`output: "export"`).
- New Pages project from `scottcampbelldata/automotive-analyst`, root directory `frontend`.
- Build command `npm run build` · output directory `out`.
- Env var `NEXT_PUBLIC_API_BASE = https://analyst-api.scottcampbell.io`.
- Add custom domain `analyst.scottcampbell.io`.

CORS already allows `analyst.scottcampbell.io` and the `*.pages.dev` preview.

## Updating
```bash
cd ~/automotive-analyst && git pull --ff-only && sudo systemctl restart analyst-api
```
Only the backend deploys this way. The frontend is built by Cloudflare Pages from
GitHub on push, so a `git pull` here does nothing for it - check the Pages build.

**Confirm the restart actually picked up the new code.** This checkout has been
found several commits behind before now, which meant a guardrail fix that was
committed and pushed was still not live:
```bash
git log --oneline -1
curl -s -X POST localhost:8010/api/ask/run -H 'content-type: application/json' \
  -d '{"question":"t","sql":"SELECT * FROM v_oee, secret_table"}'
```
The second command must come back `"guardrail":"rejected"`. It is a comma-join
against a non-allow-listed table - a shape that once passed - so it doubles as a
smoke test that the allow-list is enforced in the running process.

## Safety model
1. App guardrails: single statement, SELECT/WITH only, no DDL/admin keywords,
   blanket `pg_*` ban, info-leak function denylist, table/view allow-list
   (fail-closed), comments stripped, injected LIMIT. Attack-case tests in CI.
2. DB enforcement: dedicated read-only role + read-only transaction + statement
   timeout - safe even though `/run` accepts client-supplied SQL. Connection
   acquire is bounded, so a saturated pool returns 503 instead of hanging.
3. Abuse limits: per-IP rate limiting, keyed on an address the caller cannot
   forge (section 4) and counted in a single worker (section 3); request size
   caps in the app and in nginx.
4. Transparency: every answer returns the exact SQL that ran; one self-correction
   round on a database error.
