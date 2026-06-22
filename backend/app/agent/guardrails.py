"""
SQL guardrails for the text-to-SQL agent.

This is the security-critical layer. An LLM produces SQL text; nothing it writes
reaches the database until it passes every check here. The database is *also*
locked down (dedicated read-only role + read-only transaction + statement
timeout in runner.py), so this is the application half of a defense-in-depth
design -- not the only thing standing between a generated query and your data.

Pipeline (see validate_sql):
  0. Normalise: strip markdown fences and SQL comments (so nothing can hide
     inside a `--` line or `/* ... */` block), trim a single trailing `;`.
  1. Single statement only -- no `;` chaining.
  2. Must begin with SELECT or WITH (read-only).
  3. No write / DDL / admin keywords (INSERT, DROP, GRANT, COPY, pg_*, ...).
  4. No SELECT ... INTO (table creation).
  5. Every table/view referenced via FROM/JOIN must be on the allow-list
     (CTE names defined in the same query are allowed; a `schema.` prefix is
     tolerated but the object itself must still be allow-listed).
  6. A LIMIT is injected if the model didn't include one.

validate_sql() returns (ok: bool, message: str, cleaned_sql | None).
"""
import re

# Base tables + analytical views the agent is allowed to read. Anything not in
# this set is rejected -- an allow-list, not a block-list, so unknown objects
# (including catalog tables like pg_user / information_schema.*) fail closed.
ALLOWED = {
    "dim_asset", "dim_shift_calendar", "dim_events", "fact_fault_events",
    "fact_maintenance_events", "fact_production", "fact_defect_events", "shift_logs",
    "v_kpi_overall", "v_mttr_by_crew", "v_shift_handoff_effect", "v_yield_by_shift",
    "v_rootcause_ranking", "v_propagation", "v_propagation_paths", "v_detection_ranking",
    "v_top_faulting_assets", "v_faults_per_generation", "v_faults_by_quarter",
    "v_yield_by_quarter", "v_st03_monthly", "v_st06_monthly", "v_summer_thermal",
    "v_defects_monthly", "v_oee", "v_oee_by_line", "v_loss_by_station",
    "v_robot_candidates", "v_validation",
}

# Forbidden tokens. Two reasons a single read-only SELECT can still be dangerous:
#   (a) write / DDL / admin *statements*; and
#   (b) info-leak / admin *functions* that a SELECT can call (version(),
#       current_setting(), current_user, dblink(), ...). The keyword list below
#       covers both. A blanket ban on any pg_* identifier catches catalog tables
#       and admin functions in one rule.
# NB: `pg_*` must NOT be matched with \b…\b — `_` is a word character, so
# `\bpg_read\b` fails to match `pg_read_file`. We match the whole pg_ token.
# The read-only DB role is the ultimate backstop; this denylist is the app layer.
FORBIDDEN = re.compile(
    # (a) write / DDL / admin statements
    r'\b(insert|update|delete|drop|alter|truncate|grant|revoke|merge|call|copy|'
    r'vacuum|reindex|cluster|lock|begin|commit|rollback|reset|execute|prepare|'
    r'listen|notify|create|comment|do|'
    # (b) server / identity info-leak & cross-DB functions
    r'current_setting|set_config|current_user|session_user|current_database|'
    r'current_catalog|current_schema|version|inet_server_addr|inet_client_addr|'
    r'inet_server_port|inet_client_port|dblink|dblink_exec|dblink_connect|'
    r'txid_current|lo_import|lo_export|lo_read|lo_get)\b'
    # any pg_* identifier (catalogs + admin funcs)
    r'|\bpg_\w+',
    re.I,
)

# FROM/JOIN <optional schema.>identifier  -> capture the object name only.
_RELATION = re.compile(r'\b(?:from|join)\s+(?:[a-z_]\w*\.)?([a-z_]\w*)', re.I)
# CTE names introduced by `WITH x AS (` or `, x AS (`.
_CTE = re.compile(r'(?:with|,)\s+([a-z_]\w*)\s+as\s*\(', re.I)

_LINE_COMMENT = re.compile(r'--[^\n]*')
_BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.S)
_INCOMPLETE_TAIL = re.compile(
    r'(\b(as|and|or|where|from|join|on|group\s+by|order\s+by|having|union)\b|'
    r'[,+\-*/(])\s*(?:limit\s+\d+\s*)?$',
    re.I,
)

DEFAULT_LIMIT = 1000


def _strip_comments(s: str) -> str:
    """Remove SQL comments so they can't smuggle keywords or extra statements."""
    s = _BLOCK_COMMENT.sub(' ', s)
    s = _LINE_COMMENT.sub(' ', s)
    return s


def validate_sql(raw: str):
    s = (raw or "").strip()
    # strip any markdown code fences the model may add
    s = re.sub(r'^```(?:sql)?', '', s).strip()
    s = re.sub(r'```$', '', s).strip()
    # strip comments before any structural check
    s = _strip_comments(s).strip()
    s = s.rstrip(';').strip()

    if not s:
        return False, "empty query", None
    if ';' in s:
        return False, "only a single statement is allowed", None

    low = s.lower()
    if not (low.startswith('select') or low.startswith('with')):
        return False, "only read-only SELECT queries are allowed", None
    if FORBIDDEN.search(low):
        return False, "query contains a forbidden keyword (write / DDL / admin)", None
    if re.search(r'\bselect\b.*\binto\b', low, re.S):
        return False, "SELECT INTO is not allowed", None
    if _INCOMPLETE_TAIL.search(s):
        return False, "query appears incomplete", None

    ctes = {m.lower() for m in _CTE.findall(low)}
    rels = [m.lower() for m in _RELATION.findall(low)]
    unknown = [r for r in rels if r not in ALLOWED and r not in ctes]
    if unknown:
        return False, f"unknown table/view: {', '.join(sorted(set(unknown)))}", None

    if not re.search(r'\blimit\s+\d+', low):
        s = s + f"\nLIMIT {DEFAULT_LIMIT}"
    return True, "ok", s
