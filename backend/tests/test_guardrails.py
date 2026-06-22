"""
The security-critical tests. Guardrails are an allow-list that must fail closed:
anything not provably a single, read-only, allow-listed SELECT is rejected.
"""
import pytest

from app.agent.guardrails import DEFAULT_LIMIT, validate_sql
from app.agent.schema_context import FEW_SHOT

# ---- queries that must be ALLOWED --------------------------------------------
ALLOWED_CASES = [
    ("plain select", "SELECT * FROM fact_production"),
    ("allowed view", "SELECT * FROM v_oee"),
    ("cte / with", "WITH t AS (SELECT line FROM fact_production) SELECT * FROM t"),
    ("join two allowed", "SELECT * FROM fact_fault_events f JOIN dim_asset a ON a.asset_id = f.asset_id"),
    ("schema-qualified allowed", "SELECT * FROM public.fact_production"),
    ("subquery in where", "SELECT station FROM fact_fault_events WHERE ts = (SELECT MAX(ts) FROM fact_fault_events)"),
    ("substring trap: created_at", "SELECT created_at FROM fact_production"),
    ("substring trap: last_updated", "SELECT last_updated FROM fact_production"),
    ("uppercase keywords", "SELECT LINE FROM FACT_PRODUCTION"),
]


@pytest.mark.parametrize("label,sql", ALLOWED_CASES, ids=[c[0] for c in ALLOWED_CASES])
def test_allowed_queries_pass(label, sql):
    ok, msg, cleaned = validate_sql(sql)
    assert ok, f"{label} should pass but was rejected: {msg}"
    assert cleaned


# ---- queries / attacks that must be REJECTED ---------------------------------
REJECTED_CASES = [
    ("empty", ""),
    ("statement chaining", "SELECT 1; DROP TABLE dim_asset"),
    ("delete", "DELETE FROM fact_production"),
    ("update", "UPDATE fact_production SET yield_pct = 0"),
    ("insert", "INSERT INTO fact_production VALUES (1)"),
    ("drop", "DROP TABLE dim_asset"),
    ("truncate", "TRUNCATE fact_production"),
    ("alter", "ALTER TABLE dim_asset ADD COLUMN x int"),
    ("grant", "GRANT SELECT ON fact_production TO public"),
    ("create", "CREATE TABLE evil (id int)"),
    ("copy exfil", "COPY fact_production TO STDOUT"),
    ("select into", "SELECT * INTO evil FROM fact_production"),
    ("pg_sleep dos", "SELECT pg_sleep(10)"),
    ("pg_read_file", "SELECT pg_read_file('/etc/passwd')"),
    ("catalog table", "SELECT * FROM pg_user"),
    ("information_schema", "SELECT * FROM information_schema.tables"),
    ("unknown table", "SELECT * FROM secrets"),
    ("not a select", "EXPLAIN ANALYZE SELECT 1"),
    ("non-public schema", "SELECT * FROM pg_catalog.pg_user"),
    # function-based info-leak / abuse inside a valid single SELECT
    ("version fingerprint", "SELECT version()"),
    ("current_setting leak", "SELECT current_setting('data_directory') FROM fact_production"),
    ("current_user", "SELECT current_user"),
    ("current_database", "SELECT current_database()"),
    ("inet_server_addr", "SELECT inet_server_addr()"),
    ("set_config", "SELECT set_config('work_mem', '1GB', false)"),
    ("dblink via lateral", "SELECT * FROM fact_production f, LATERAL dblink('host=x', 'SELECT 1') AS t(a int)"),
    ("union to information_schema", "SELECT line FROM fact_production UNION ALL SELECT table_name FROM information_schema.tables"),
    ("trailing alias", "SELECT station, ROUND(SUM(downtime_min) / 60.0, 2) AS"),
    ("trailing alias before limit", "SELECT station, ROUND(SUM(downtime_min) / 60.0, 2) AS\nLIMIT 1000"),
]


@pytest.mark.parametrize("label,sql", REJECTED_CASES, ids=[c[0] for c in REJECTED_CASES])
def test_attacks_are_rejected(label, sql):
    ok, msg, cleaned = validate_sql(sql)
    assert not ok, f"{label} should be rejected but passed"
    assert cleaned is None


# ---- comment-based obfuscation must not get past the checks ------------------
def test_line_comment_cannot_hide_second_statement():
    # the '--' comment is stripped, exposing the chained statement / keyword
    ok, _, _ = validate_sql("SELECT 1 --\nDROP TABLE dim_asset")
    assert not ok


def test_block_comment_cannot_hide_keyword():
    ok, _, _ = validate_sql("SELECT * FROM fact_production /* ; DELETE FROM dim_asset */")
    # comment stripped -> just a plain select; must remain safe (allowed)
    assert ok


def test_block_comment_hiding_unknown_table_is_ignored_safely():
    ok, _, cleaned = validate_sql("SELECT * /* FROM secrets */ FROM v_oee")
    assert ok and "v_oee" in cleaned.lower()


# ---- LIMIT injection ----------------------------------------------------------
def test_limit_is_injected_when_missing():
    ok, _, cleaned = validate_sql("SELECT line FROM fact_production")
    assert ok and f"LIMIT {DEFAULT_LIMIT}" in cleaned


def test_existing_limit_is_preserved():
    ok, _, cleaned = validate_sql("SELECT line FROM fact_production LIMIT 5")
    assert ok and "LIMIT 5" in cleaned and "LIMIT 1000" not in cleaned


def test_markdown_fences_are_stripped():
    ok, _, cleaned = validate_sql("```sql\nSELECT 1 AS ok\n```")
    assert ok and "`" not in cleaned


# ---- every shipped few-shot example must itself pass the guardrails ----------
@pytest.mark.parametrize("question,sql", FEW_SHOT, ids=[q for q, _ in FEW_SHOT])
def test_every_few_shot_example_passes(question, sql):
    ok, msg, _ = validate_sql(sql)
    assert ok, f"few-shot example {question!r} fails guardrails: {msg}"
