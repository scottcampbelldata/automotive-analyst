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

# Relations are extracted by _relations() below rather than by a regex: a regex
# anchored on FROM/JOIN cannot see the second and later items of a comma-
# separated relation list (`FROM a, b`), which is how the allow-list was bypassed.
# CTE names introduced by `WITH x AS (` or `, x AS (`.
_CTE = re.compile(r'(?:with|,)\s+("[^"]+"|[a-z_]\w*)\s+as\s*\(', re.I)

# Dollar quoting ($$...$$ / $tag$...$tag$) has no place in an analytical SELECT
# and is a standard way to smuggle a payload past a scanner, so it is rejected.
_DOLLAR_QUOTE = re.compile(r'\$[a-z_]*\$', re.I)
# FUNC( ... FROM ... ) idioms where FROM is an argument separator, not a source.
_FROM_IDIOM = re.compile(
    r'\b(extract|substring|position|overlay|trim)\s*\(([^()]*)\)', re.I)


def _normalize_relation(name: str) -> str:
    """Fold a captured relation name to its comparable form.

    Drops an optional schema qualifier (`public.fact_production` -> the object
    name) and unquotes. Splitting is quote-aware so a dot inside a quoted
    identifier is not mistaken for a qualifier separator.
    """
    parts, buf, in_quotes = [], [], False
    for ch in name.strip():
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif ch == '.' and not in_quotes:
            parts.append(''.join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append(''.join(buf))

    obj = parts[-1].strip()
    if obj.startswith('"') and obj.endswith('"') and len(obj) >= 2:
        obj = obj[1:-1]
    return obj.strip().lower()


def _mask_from_idioms(s: str) -> str:
    """Blank FROM inside EXTRACT()/SUBSTRING()-style calls, where it is not a source."""
    return _FROM_IDIOM.sub(lambda m: m.group(0).replace('from', ' ').replace('FROM', ' '), s)

_INCOMPLETE_TAIL = re.compile(
    r'(\b(as|and|or|where|from|join|on|group\s+by|order\s+by|having|union)\b|'
    r'[,+\-*/(])\s*(?:limit\s+\d+\s*)?$',
    re.I,
)

DEFAULT_LIMIT = 1000


def _scan(s: str):
    """One pass over the SQL producing (stripped, masked, error).

    stripped - `s` with comments removed and string literals left INTACT. This is
               what gets executed, so it has to stay semantically identical.
    masked   - the same text with the *contents* of string literals blanked, so
               keyword and relation scanning sees only code, never data.

    Comments are recognised only OUTSIDE string literals and quoted identifiers.
    The previous implementation regex-stripped comments before masking literals,
    so a `--` inside a literal truncated the query (`'WELD--SPATTER'` became
    `'WELD`) and a `/* */` spanning two literals silently deleted the text
    between them - in both cases validate_sql still returned ok.

    Block comments nest in Postgres, so they are counted rather than matched
    with a non-greedy regex. An unterminated literal or comment is an error:
    the input is malformed and must fail closed rather than be guessed at.
    """
    out: list[str] = []
    scan: list[str] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        # string literal - data. '' is an escaped quote and does not end it.
        if c == "'":
            j = i + 1
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                return '', '', 'unterminated string literal'
            out.append(s[i:j + 1])
            scan.append("''")
            i = j + 1
            continue
        # quoted identifier - code, so it is kept in the masked copy too.
        if c == '"':
            j = i + 1
            while j < n:
                if s[j] == '"':
                    if j + 1 < n and s[j + 1] == '"':
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                return '', '', 'unterminated quoted identifier'
            out.append(s[i:j + 1])
            scan.append(s[i:j + 1])
            i = j + 1
            continue
        if s.startswith('--', i):
            j = s.find('\n', i)
            j = n if j == -1 else j
            out.append(' ')
            scan.append(' ')
            i = j
            continue
        if s.startswith('/*', i):
            depth, j = 1, i + 2
            while j < n and depth:
                if s.startswith('/*', j):
                    depth += 1
                    j += 2
                elif s.startswith('*/', j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            if depth:
                return '', '', 'unterminated block comment'
            out.append(' ')
            scan.append(' ')
            i = j
            continue
        out.append(c)
        scan.append(c)
        i += 1
    return ''.join(out), ''.join(scan), None


# Tokens for the FROM-clause parser. An identifier may be schema-qualified and
# either part may be quoted.
_IDENT = r'(?:"[^"]*"|[a-z_][\w$]*)'
_TOKEN = re.compile(
    r'(?P<ident>' + _IDENT + r'(?:\s*\.\s*' + _IDENT + r')*)'
    r'|(?P<punc>[(),])'
    r'|(?P<other>\S)',
    re.I,
)

# Keywords that end a FROM clause. NB: `on`, `using` and `join` do NOT - they are
# internal to it, and a comma may still follow them (`FROM a JOIN b ON x, c`).
_FROM_END = {
    'where', 'group', 'having', 'order', 'limit', 'offset', 'union', 'intersect',
    'except', 'window', 'fetch', 'for', 'returning', 'into',
}
# Noise words that may precede the relation name itself.
_PRE_RELATION = {'only', 'lateral'}


def _relations(masked: str):
    """Every relation named in a FROM/JOIN clause, plus a parse-success flag.

    Returns (names, ok). ok is False when a relation position could not be
    classified, which must fail the query closed.

    The old regex only anchored on FROM/JOIN, so in `FROM a, b` it captured `a`
    and never saw `b` - and because the fail-closed counter compared FROM/JOIN
    *keyword* counts against parsed relations, the comma added no keyword and the
    count still matched. Every item of the relation list is now parsed, at any
    nesting depth.
    """
    names: list[str] = []
    depth = 0
    # Whether a FROM clause is open, tracked PER nesting depth. A single flag was
    # not enough: in `FROM (SELECT a FROM t WHERE a>1) x, secret_table` the inner
    # subquery's WHERE closed the flag, so the outer depth-0 comma no longer
    # looked like a relation list and `secret_table` was never checked.
    from_at: dict[int, bool] = {}
    expect = False  # a relation is required at this position

    for m in _TOKEN.finditer(masked):
        ident, punc = m.group('ident'), m.group('punc')
        word = ident.lower() if ident else None

        if punc == '(':
            if expect:  # FROM ( subquery ) - a valid, self-validating source
                expect = False
            depth += 1
            continue
        if punc == ')':
            from_at.pop(depth, None)  # this nesting level is finished
            depth = max(0, depth - 1)
            continue
        if punc == ',':
            if from_at.get(depth):
                expect = True  # next item of the relation list
            continue

        if expect:
            if word in _PRE_RELATION:
                continue
            if word is None or word in _FROM_END:
                return names, False  # relation position held something unparseable
            names.append(_normalize_relation(ident))
            expect = False
            continue

        if word in ('from', 'join'):
            from_at[depth] = True
            expect = True
        elif word in _FROM_END and from_at.get(depth):
            from_at[depth] = False

    return names, not expect


def validate_sql(raw: str):
    s = (raw or "").strip()
    # strip any markdown code fences the model may add
    s = re.sub(r'^```(?:sql)?', '', s).strip()
    s = re.sub(r'```$', '', s).strip()
    # Dollar quoting is rejected before scanning: $$...$$ has its own quoting
    # rules that the literal-aware scanner below deliberately does not model.
    if _DOLLAR_QUOTE.search(s):
        return False, "dollar-quoted strings are not allowed", None

    # One literal-aware pass: comments out, string contents masked for scanning.
    s, masked, err = _scan(s)
    if err:
        return False, err, None
    s = s.strip().rstrip(';').strip()
    masked = masked.strip().rstrip(';').strip()

    if not s:
        return False, "empty query", None
    # Statement separation is checked against the masked copy: a semicolon inside
    # a string is data and cannot terminate a statement, so SELECT 'a; b' is a
    # single statement and must not be refused.
    if ';' in masked:
        return False, "only a single statement is allowed", None

    # Keyword scanning runs against the masked copy. The literals are data;
    # without this, SELECT 'drop' AS label is rejected.
    scan = masked.lower()
    if not (scan.startswith('select') or scan.startswith('with')):
        return False, "only read-only SELECT queries are allowed", None

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
    rels, parsed = _relations(rel_scan)

    # Fail closed: if any relation position could not be classified, the
    # allow-list has a hole and the query is refused rather than passed through
    # on an incomplete match set.
    if not parsed:
        return False, "could not parse every FROM/JOIN source", None

    unknown = [r for r in rels if r not in ALLOWED and r not in ctes]
    if unknown:
        return False, f"unknown table/view: {', '.join(sorted(set(unknown)))}", None

    # LIMIT detection runs against the masked copy as well - checking `low` meant
    # a literal such as WHERE x = 'limit 5' suppressed the injected LIMIT and
    # let an unbounded result set through.
    if not re.search(r'\blimit\s+\d+', scan):
        s = s + f"\nLIMIT {DEFAULT_LIMIT}"
    return True, "ok", s
