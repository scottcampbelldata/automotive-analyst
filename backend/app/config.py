"""
Configuration for the Automotive Analyst backend.

This service holds **no LLM API key**. Visitors bring their own key (Claude,
OpenAI, or Gemini); SQL is generated in their browser and sent here only to be
validated and executed. So the backend's only secret is the read-only database
connection. It connects to the SAME PostgreSQL that powers the dashboard
(manufacturing-intelligence-platform) via a READ-ONLY role (factory_ro).
"""
import os

from dotenv import load_dotenv

load_dotenv()

# Read-only connection to the existing dashboard database.
# Create the role once (see deploy/RUNBOOK.md):
#   CREATE ROLE factory_ro LOGIN PASSWORD '...';
#   GRANT CONNECT ON DATABASE manufacturing TO factory_ro;
#   GRANT USAGE ON SCHEMA public TO factory_ro;
#   GRANT SELECT ON ALL TABLES IN SCHEMA public TO factory_ro;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO factory_ro;
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://factory_ro:CHANGEME@localhost:5432/manufacturing",
)

# Frontend origin (Cloudflare Pages). Comma-separated for multiple.
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS", "https://analyst.scottcampbell.io,http://localhost:3000"
    ).split(",")
    if o.strip()
]

# Guardrails on the public /run endpoint (it executes client-supplied SQL).
MAX_QUESTION_CHARS = int(os.environ.get("MAX_QUESTION_CHARS", "500"))
MAX_SQL_CHARS = int(os.environ.get("MAX_SQL_CHARS", "4000"))
RATE_LIMIT_MAX = int(os.environ.get("RATE_LIMIT_MAX", "20"))            # requests
RATE_LIMIT_WINDOW_S = int(os.environ.get("RATE_LIMIT_WINDOW_S", "60"))  # per window
QUERY_TIMEOUT_MS = int(os.environ.get("QUERY_TIMEOUT_MS", "5000"))

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
