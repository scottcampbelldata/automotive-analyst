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
# NB: `pg_*` must NOT be matched with \b…\b - `_` is a word character, so
# `\bpg_read\b` fails to match `pg_read_file`. We match the whole pg_ token.
# The read-only DB role is the ultimate backstop; this denylist is the app layer.
FORBIDDEN = re.compile(
    # (a) write / DDL / admin statements -- banned as bare words
    r'\b(insert|update|delete|drop|alter|truncate|grant|revoke|merge|call|copy|'
    r'vacuum|reindex|cluster|lock|begin|commit|rollback|reset|execute|prepare|'
    r'listen|notify|create|comment|do|'
    # (b) identity keywords that are legal *without* parentheses in Postgres,
    #     so they have to be banned bare too
    r'current_user|session_user|current_database|current_catalog|current_schema)\b'
    # any pg_* identifier (catalogs + admin funcs)
    r'|\bpg_\w+',
    re.I,
)

# (c) admin / info-leak *functions*. These are only dangerous when invoked, so
# they are matched with a following "(" -- otherwise a perfectly ordinary column
# named `version` gets the whole query rejected.
FORBIDDEN_CALL = re.compile(
    r'\b(current_setting|set_config|version|inet_server_addr|inet_client_addr|'
    r'inet_server_port|inet_client_port|dblink|dblink_exec|dblink_connect|'
    r'txid_current|lo_import|lo_export|lo_read|lo_get)\s*\(',
    re.I,
)

# FROM/JOIN <optional schema.>identifier -> capture the object name.
# Quoted identifiers must be matched here: Postgres accepts FROM "users", and a
# pattern restricted to [a-z_] simply fails to match it, which meant the
# allow-list below was skipped entirely rather than failing closed.
_RELATION = re.compile(
    r'\b(?:from|join)\s+'
    r'(?:(?:"[^"]+"|[a-z_]\w*)\s*\.\s*)?'   # optional schema, quoted or bare
    r'("[^"]+"|[a-z_]\w*)',                 # object, quoted or bare
    re.I,
)
# Every FROM/JOIN that introduces a relation, so unparsed ones can be counted.
_FROM_JOIN = re.compile(r'\b(?:from|join)\b', re.I)
# FROM/JOIN followed by a subquery or a VALUES list, which have no object name.
_FROM_PAREN = re.compile(r'\b(?:from|join)\s*\(', re.I)
# CTE names introduced by `WITH x AS (` or `, x AS (`.
_CTE = re.compile(r'(?:with|,)\s+("[^"]+"|[a-z_]\w*)\s+as\s*\(', re.I)

# SQL string literals, with '' as the escape for a literal quote. Contents are
# data and can never execute, so they are masked before keyword scanning.
_STRING_LITERAL = re.compile(r"'(?:[^']|'')*'")
# Dollar quoting ($$...$$ / $tag$...$tag$) has no place in an analytical SELECT
# and is a standard way to smuggle a payload past a scanner, so it is rejected.
_DOLLAR_QUOTE = re.compile(r'\$[a-z_]*\$', re.I)
# FUNC( ... FROM ... ) idioms where FROM is an argument separator, not a source.
_FROM_IDIOM = re.compile(
    r'\b(extract|substring|position|overlay|trim)\s*\(([^()]*)\)', re.I)


def _normalize_relation(name: str) -> str:
    """Fold a captured relation name to its comparable form."""
    name = name.strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    return name.strip().lower()


def _mask_literals(s: str) -> str:
    """Blank the contents of string literals so keyword scanning sees only code."""
    return _STRING_LITERAL.sub("''", s)


def _mask_from_idioms(s: str) -> str:
    """Blank FROM inside EXTRACT()/SUBSTRING()-style calls, where it is not a source."""
    return _FROM_IDIOM.sub(lambda m: m.group(0).replace('from', ' ').replace('FROM', ' '), s)

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
    # Statement separation is checked against a literal-masked copy: a semicolon
    # inside a string is data and cannot terminate a statement, so
    # SELECT 'a; b' is a single statement and must not be refused.
    if ';' in _mask_literals(s):
        return False, "only a single statement is allowed", None

    low = s.lower()
    if not (low.startswith('select') or low.startswith('with')):
        return False, "only read-only SELECT queries are allowed", None
    if _DOLLAR_QUOTE.search(s):
        return False, "dollar-quoted strings are not allowed", None

    # Keyword scanning runs against a copy with string-literal contents blanked.
    # The literals are data; without this, SELECT 'drop' AS label is rejected.
    scan = _mask_literals(low)
    if FORBIDDEN.search(scan):
        return False, "query contains a forbidden keyword (write / DDL / admin)", None
    if FORBIDDEN_CALL.search(scan):
        return False, "query calls a forbidden function (server / identity info)", None
    if re.search(r'\bselect\b.*\binto\b', scan, re.S):
        return False, "SELECT INTO is not allowed", None
    if _INCOMPLETE_TAIL.search(s):
        return False, "query appears incomplete", None

    # Relations are read from the masked copy too, so a table name inside a
    # string literal cannot be mistaken for a source.
    rel_scan = _mask_from_idioms(scan)
    ctes = {_normalize_relation(m) for m in _CTE.findall(rel_scan)}
    rels = [_normalize_relation(m) for m in _RELATION.findall(rel_scan)]
    unknown = [r for r in rels if r not in ALLOWED and r not in ctes]
    if unknown:
        return False, f"unknown table/view: {', '.join(sorted(set(unknown)))}", None

    # Fail closed: every FROM/JOIN must have been accounted for, either as a
    # named relation or as a parenthesised subquery. If the parser could not
    # classify one, the allow-list has a hole and the query is refused rather
    # than passed through on an empty match set.
    accounted = len(rels) + len(_FROM_PAREN.findall(rel_scan))
    if len(_FROM_JOIN.findall(rel_scan)) > accounted:
        return False, "could not parse every FROM/JOIN source", None

    if not re.search(r'\blimit\s+\d+', low):
        s = s + f"\nLIMIT {DEFAULT_LIMIT}"
    return True, "ok", s
