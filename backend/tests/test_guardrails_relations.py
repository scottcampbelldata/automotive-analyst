"""
Regression tests for three guardrail defects found in the July 2026 audit:

  1. Comma-separated FROM lists bypassed the table allow-list entirely.
     `_RELATION` only anchored on FROM/JOIN, so it captured the first item and
     never saw `, secret_table`. The fail-closed counter compared FROM/JOIN
     *keywords* against parsed relations, and a comma adds no keyword, so the
     count matched and the query passed.
  2. Comments were stripped before string literals were masked, so a `--` or
     `/* */` inside a literal truncated or rewrote the query. validate_sql then
     returned ok=True for SQL that was syntactically invalid or semantically
     different from what the model wrote.
  3. The LIMIT-injection check ran against the unmasked SQL, so a literal
     containing the text "limit 5" suppressed the injected LIMIT.
"""
import pytest

from app.agent.guardrails import DEFAULT_LIMIT, validate_sql


def ok(sql):
    passed, msg, cleaned = validate_sql(sql)
    return passed, msg, cleaned


# --- 1. comma-join allow-list bypass -------------------------------------

BYPASSES = [
    "SELECT * FROM v_oee, secret_table",
    "SELECT * FROM v_oee, users, api_keys",
    "SELECT a.x FROM v_oee a, private_salaries p",
    "SELECT * FROM v_oee, information_schema.tables",
    "SELECT * FROM v_oee JOIN dim_asset ON true, secret_table",
    "SELECT * FROM (SELECT 1) q, secret_table",
    "WITH c AS (SELECT * FROM v_oee, secret_table) SELECT * FROM c",
    "SELECT 1 FROM v_oee UNION SELECT 1 FROM v_oee, secret_table",
    # the comma-join hiding behind an ON clause, so the trailing item is not
    # adjacent to the FROM keyword at all
    "SELECT * FROM v_oee o JOIN dim_asset d ON o.station = d.station, secret_table",
    # nested one level down inside a subquery
    "SELECT * FROM (SELECT * FROM v_oee, secret_table) t",
    # a subquery whose own clause keywords must not close the OUTER relation
    # list - this is what a single in_from flag got wrong
    "SELECT * FROM (SELECT a FROM v_oee WHERE a > 1) t, secret_table",
    "SELECT * FROM (SELECT a FROM v_oee GROUP BY a) t, secret_table",
    "SELECT * FROM (SELECT a FROM v_oee ORDER BY a LIMIT 1) t, secret_table",
    "SELECT * FROM ((SELECT a FROM v_oee WHERE a > 1)) t, secret_table",
    "SELECT * FROM (SELECT * FROM (SELECT a FROM v_oee WHERE a > 1) x WHERE a > 2) y, secret_table",
    "WITH c AS (SELECT a FROM v_oee WHERE a > 1) SELECT * FROM c, secret_table",
    # explicit join syntaxes
    "SELECT * FROM v_oee CROSS JOIN secret_table",
    "SELECT * FROM v_oee NATURAL JOIN secret_table",
    "SELECT * FROM ONLY secret_table",
    "SELECT * FROM secret_table AS t",
    'SELECT * FROM "secret table"',
    "SELECT * FROM v_oee,secret_table",
]


@pytest.mark.parametrize("sql", BYPASSES)
def test_comma_join_cannot_escape_the_allow_list(sql):
    passed, msg, _ = ok(sql)
    assert not passed, f"allow-list bypassed by: {sql}"


# --- legitimate queries must still pass ----------------------------------

LEGIT = [
    "SELECT * FROM v_oee",
    "SELECT availability_pct, oee_pct FROM v_oee",
    "SELECT * FROM fact_fault_events f JOIN dim_asset d ON f.asset_id = d.asset_id",
    "SELECT * FROM v_oee, dim_asset",  # comma join, BOTH allow-listed
    "SELECT * FROM fact_production p, dim_asset a WHERE p.line = a.line",
    "WITH c AS (SELECT crew, mttr_min FROM v_mttr_by_crew) SELECT * FROM c",
    "SELECT * FROM (SELECT line FROM fact_production) q",
    "SELECT date_trunc('month', ts) AS month, COUNT(*) FROM fact_defect_events GROUP BY 1",
    "SELECT EXTRACT(month FROM ts) AS m, COUNT(*) FROM fact_fault_events GROUP BY 1",
    "SELECT station, SUM(downtime_min) FROM fact_fault_events GROUP BY station ORDER BY 2 DESC LIMIT 5",
    "SELECT * FROM v_oee o LEFT JOIN v_oee_by_line l ON o.oee_pct = l.oee_pct",
    # a subquery with its own WHERE/GROUP BY, then more allow-listed relations
    "SELECT * FROM (SELECT line FROM fact_production WHERE line IS NOT NULL) q",
    "SELECT * FROM (SELECT a FROM v_oee WHERE a > 1) t, dim_asset",
    "SELECT station, SUM(downtime_min) FROM fact_fault_events WHERE crew IN ('A','B') GROUP BY station",
    "SELECT EXTRACT(month FROM ts) m, COUNT(*) FROM fact_fault_events GROUP BY 1, 2",
]


@pytest.mark.parametrize("sql", LEGIT)
def test_legitimate_queries_still_pass(sql):
    passed, msg, _ = ok(sql)
    assert passed, f"false positive on legitimate SQL: {sql} -> {msg}"


# --- 2. comments inside string literals ----------------------------------

def test_double_dash_inside_literal_is_data_not_a_comment():
    sql = "SELECT * FROM fact_defect_events WHERE defect_type = 'WELD--SPATTER'"
    passed, msg, cleaned = ok(sql)
    assert passed, msg
    assert "WELD--SPATTER" in cleaned, f"literal was truncated: {cleaned!r}"


def test_block_comment_inside_literal_is_data():
    sql = "SELECT 'a/*' AS x, 'b*/' AS y FROM v_oee"
    passed, msg, cleaned = ok(sql)
    assert passed, msg
    assert "'a/*'" in cleaned and "'b*/'" in cleaned, f"query rewritten: {cleaned!r}"


def test_real_comments_are_still_stripped():
    passed, _, cleaned = ok("SELECT 1 -- drop table x\nFROM v_oee")
    assert passed
    assert "drop" not in cleaned.lower()


def test_block_comment_is_still_stripped():
    passed, _, cleaned = ok("SELECT 1 /* drop table x */ FROM v_oee")
    assert passed
    assert "drop" not in cleaned.lower()


def test_unterminated_literal_is_rejected():
    passed, msg, _ = ok("SELECT * FROM v_oee WHERE x = 'abc")
    assert not passed


# --- 3. LIMIT injection ---------------------------------------------------

def test_limit_is_injected_when_absent():
    _, _, cleaned = ok("SELECT * FROM fact_production")
    assert cleaned.rstrip().endswith(f"LIMIT {DEFAULT_LIMIT}")


def test_literal_containing_the_word_limit_does_not_suppress_injection():
    _, _, cleaned = ok("SELECT * FROM fact_production WHERE line_id = 'limit 5'")
    assert cleaned.rstrip().endswith(f"LIMIT {DEFAULT_LIMIT}"), (
        f"a string literal suppressed the injected LIMIT: {cleaned!r}"
    )


def test_real_limit_is_respected():
    _, _, cleaned = ok("SELECT * FROM fact_production LIMIT 10")
    assert cleaned.count("LIMIT") == 1 and cleaned.rstrip().endswith("LIMIT 10")
