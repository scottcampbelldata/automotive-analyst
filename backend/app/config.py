"""
Configuration for the Automotive Analyst.

The agent connects to the SAME PostgreSQL database that powers the dashboard
(manufacturing-intelligence-platform) -- it does NOT own or duplicate the data.
Use a READ-ONLY database role here (factory_ro); the agent never writes.
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

# SQL generation provider: "anthropic" (default) or "ollama".
AGENT_PROVIDER = os.environ.get("AGENT_PROVIDER", "anthropic")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "sqlcoder")
