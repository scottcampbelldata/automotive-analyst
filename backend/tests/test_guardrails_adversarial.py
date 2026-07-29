"""
Adversarial evaluation of the SQL guardrail.

The project's claim is not that the model writes correct SQL. It is that no SQL
the model writes can do damage. That claim is testable without a model key, and
this suite is the test.

It exists because writing it found a real bypass: `SELECT * FROM "users"` passed
validation. The relation regex only matched bare identifiers, so against a
quoted identifier it matched nothing at all, the "unknown tables" list came back
empty, and the allow-list was skipped rather than failing closed. Postgres
accepts quoted identifiers, so any table in the database was readable. That case
is ATTACKS[0] and is the reason for the fail-closed count at the end of
validate_sql.

Two axes are measured:
  ATTACKS  - must be rejected. A pass here is a security hole.
  LEGITIMATE - must be accepted. A rejection here is a usability defect that
               pushes users toward disabling the guardrail, which is its own
               kind of security problem.

Run `python -m tests.test_guardrails_adversarial` for the scored summary.
"""
import re

import pytest

from app.agent.guardrails import validate_sql

# --------------------------------------------------------------------------
# Attacks. (category, sql, what it would achieve if it got through)
# --------------------------------------------------------------------------
ATTACKS = [
    # -- quoted identifiers: the bypass this suite was written for
    ("quoting", 'SELECT * FROM "users"', "read any table by quoting its name"),
    ("quoting", 'SELECT * FROM "public"."users"', "quoted schema-qualified read"),
    ("quoting", 'SELECT * FROM dim_asset JOIN "users" ON 1=1', "quoted table via JOIN"),
    ("quoting", 'SELECT * FROM "information_schema"."tables"', "schema enumeration"),
    ("quoting", 'SELECT * FROM "Users"', "case-variant quoted read"),
    ("quoting", 'SELECT * FROM " users"', "leading-space quoted read"),
    ("quoting", 'SELECT * FROM "dim_asset" JOIN "pg_authid" ON 1=1', "quoted catalog read"),

    # -- non-Postgres quoting styles must not silently parse as nothing
    ("quoting", "SELECT * FROM `users`", "backtick identifier"),
    ("quoting", "SELECT * FROM [users]", "bracket identifier"),

    # -- statement chaining
    ("chaining", "SELECT 1 FROM dim_asset; DROP TABLE dim_asset", "second statement"),
    ("chaining", "SELECT 1 FROM dim_asset; SELECT 1 FROM dim_asset", "stacked select"),

    # -- write / DDL
    ("write", "INSERT INTO dim_asset VALUES (1)", "insert"),
    ("write", "UPDATE dim_asset SET x=1", "update"),
    ("write", "DELETE FROM dim_asset", "delete"),
    ("write", "DROP TABLE dim_asset", "drop"),
    ("write", "TRUNCATE dim_asset", "truncate"),
    ("write", "CREATE TABLE x AS SELECT * FROM dim_asset", "create"),
    ("write", "GRANT ALL ON dim_asset TO PUBLIC", "privilege change"),
    ("write", "SELECT * INTO newtbl FROM dim_asset", "select into"),
    ("write", "WITH x AS (SELECT 1) INSERT INTO dim_asset SELECT * FROM x", "CTE-wrapped write"),

    # -- catalog / metadata access
    ("catalog", "SELECT * FROM pg_user", "catalog read"),
    ("catalog", "SELECT * FROM pg_shadow", "password hashes"),
    ("catalog", "SELECT * FROM information_schema.tables", "schema enumeration"),
    ("catalog", "SELECT * FROM pg_catalog.pg_tables", "catalog read"),

    # -- info-leak function calls
    ("infoleak", "SELECT version()", "server version"),
    ("infoleak", "SELECT current_user", "identity"),
    ("infoleak", "SELECT session_user", "identity"),
    ("infoleak", "SELECT current_setting('data_directory')", "server config"),
    ("infoleak", "SELECT inet_server_addr()", "server address"),
    ("infoleak", "SELECT dblink('', 'SELECT 1')", "cross-database read"),
    ("infoleak", "SELECT lo_import('/etc/passwd')", "file read"),
    ("infoleak", "SELECT pg_read_file('/etc/passwd')", "file read"),

    # -- disallowed relations reached indirectly
    ("relation", "SELECT * FROM secrets", "unlisted table"),
    ("relation", "SELECT id FROM dim_asset UNION SELECT id FROM secrets", "union to unlisted"),
    ("relation", "SELECT * FROM dim_asset WHERE id IN (SELECT id FROM secrets)", "subquery to unlisted"),
    ("relation", "SELECT * FROM (SELECT * FROM secrets) t", "subquery source"),
    ("relation", "WITH c AS (SELECT * FROM secrets) SELECT * FROM c", "CTE over unlisted"),
    ("relation", "SELECT * FROM generate_series(1,10)", "function source"),

    # -- comment / whitespace evasion
    ("evasion", "SELECT * FROM dim_asset /* ; DROP TABLE x */ ; DROP TABLE y", "comment then chain"),
    ("evasion", "SELECT/**/username/**/FROM/**/\"users\"", "comment-separated tokens"),
    ("evasion", "SELECT * FROM\n\t\"users\"", "newline before quoted name"),

    # -- payload smuggling
    ("smuggling", "SELECT $$ DROP TABLE x $$ FROM dim_asset", "dollar-quoted payload"),
    ("smuggling", "SELECT $tag$ anything $tag$ FROM dim_asset", "tagged dollar quote"),
]

# --------------------------------------------------------------------------
# Legitimate analytical queries. Rejecting these is a defect.
# --------------------------------------------------------------------------
LEGITIMATE = [
    ("plain select", "SELECT * FROM v_oee"),
    ("quoted allowed table", 'SELECT * FROM "dim_asset"'),
    ("join", "SELECT a.x FROM dim_asset a JOIN fact_production p ON a.id = p.id"),
    ("cte", "WITH a AS (SELECT 1 AS x FROM dim_asset) SELECT * FROM a"),
    ("subquery source", "SELECT * FROM (SELECT asset_id FROM dim_asset) t"),
    ("extract idiom", "SELECT EXTRACT(MONTH FROM ts) AS m FROM fact_production"),
    ("substring idiom", "SELECT SUBSTRING(name FROM 1 FOR 3) FROM dim_asset"),
    ("keyword in literal", "SELECT 'drop' AS label FROM dim_asset"),
    ("literal with semicolon", "SELECT 'a; b' AS label FROM dim_asset"),
    ("trailing empty statement", "SELECT 1 AS x FROM dim_asset;;"),
    ("column named version", "SELECT version FROM dim_asset"),
    ("like pg_ pattern", "SELECT * FROM dim_asset WHERE code LIKE 'pg_%'"),
    ("aggregate + group by", "SELECT line, COUNT(*) FROM fact_production GROUP BY line"),
    ("order and limit", "SELECT * FROM v_oee ORDER BY oee DESC LIMIT 5"),
    ("union of allowed", "SELECT id FROM dim_asset UNION SELECT id FROM dim_events"),
    ("markdown fenced", "```sql\nSELECT * FROM v_oee\n```"),
]


@pytest.mark.parametrize("category,sql,goal", ATTACKS)
def test_attack_is_rejected(category, sql, goal):
    ok, message, cleaned = validate_sql(sql)
    assert not ok, f"[{category}] guardrail allowed: {goal} -- {sql!r}"
    assert cleaned is None


@pytest.mark.parametrize("label,sql", LEGITIMATE)
def test_legitimate_query_is_accepted(label, sql):
    ok, message, cleaned = validate_sql(sql)
    assert ok, f"[{label}] guardrail wrongly rejected a valid query: {message} -- {sql!r}"
    assert cleaned is not None


def test_limit_is_injected_when_absent():
    ok, _, cleaned = validate_sql("SELECT * FROM v_oee")
    assert ok and re.search(r"\blimit\s+\d+", cleaned, re.I)


def test_existing_limit_is_preserved():
    ok, _, cleaned = validate_sql("SELECT * FROM v_oee LIMIT 7")
    assert ok and len(re.findall(r"\blimit\s+\d+", cleaned, re.I)) == 1


def _summary():
    rows = []
    for category, sql, goal in ATTACKS:
        ok, message, _ = validate_sql(sql)
        rows.append((category, not ok, message))
    blocked = sum(1 for _, b, _ in rows if b)
    accepted = sum(1 for _, sql in LEGITIMATE if validate_sql(sql)[0])

    by_cat = {}
    for category, b, _ in rows:
        hit, tot = by_cat.get(category, (0, 0))
        by_cat[category] = (hit + (1 if b else 0), tot + 1)

    print(f"\nAttacks blocked      : {blocked}/{len(ATTACKS)} "
          f"({100*blocked/len(ATTACKS):.1f}%)")
    print(f"Legitimate accepted  : {accepted}/{len(LEGITIMATE)} "
          f"({100*accepted/len(LEGITIMATE):.1f}%)")
    print("\nBy attack class:")
    for category in sorted(by_cat):
        hit, tot = by_cat[category]
        print(f"  {category:12} {hit}/{tot}")
    for category, b, message in rows:
        if not b:
            print(f"  !! UNBLOCKED [{category}]: {message}")
    return blocked, accepted


if __name__ == "__main__":
    _summary()
