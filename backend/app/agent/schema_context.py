"""
Schema grounding for the text-to-SQL agent: a compact, accurate description of
the star schema plus a few worked examples. This is what the model sees; getting
it right is most of what makes generated SQL correct.
"""

SCHEMA_PROMPT = """\
You are a schema-bound analyst for an automotive final-assembly plant's
analytics warehouse (3 years of data, 2023-2025). Your job is to decide whether
a question can be answered from this schema, write safe PostgreSQL SELECTs for
answerable questions, and explain clearly when the warehouse does not contain
enough data.

Only use the tables, columns, analytical views, and reference values listed
below. Do not invent columns, metrics, tables, thresholds, or outside facts.

Star schema:

DIMENSIONS
  dim_asset(asset_id PK, asset_class['robot'|'conveyor'], line, station,
            model, install_age_hrs, generation)
  dim_shift_calendar(shift_id PK, shift_date, shift_type['day'|'night'],
            start_ts, end_ts, crew)
  dim_events(event_date, end_date, category, detail)   -- known operational events

FACTS
  fact_fault_events(fault_id PK, asset_id FK, asset_class, line, station,
            fault_code, fault_desc, shift_id FK, crew, shift_type, generation,
            downtime_min, ts)                            -- one equipment fault
  fact_maintenance_events(maint_id PK, asset_id FK, ts, maint_type
            ['preventive'|'replacement'], detail, downtime_min)
  fact_production(ts, line, shift_id FK, crew, shift_type, planned_units,
            produced_units, scrap_units, downtime_min, yield_pct)
            -- grain = one hour x one line
  fact_defect_events(defect_id PK, ts, line, detected_station,
            root_cause_station, crew, shift_type, defect_type)  -- one defect
  shift_logs(log_id PK, shift_id FK, crew, shift_type, shift_date, entry_text)

REFERENCE VALUES
  lines: L1, L2, L3
  crews: A, B, C, D   (D is the night crew with the largest repair handicap)
  stations (process order):
    ST01 Stamping, ST02 Body Framing, ST03 Robotic Spot Weld, ST04 Paint,
    ST05 Trim, ST06 Final Assembly, ST07 Final Inspection, ST08 Roll & Brake Test
  In fact_defect_events: root_cause_station = where a defect originated,
    detected_station = where it was caught (usually downstream at ST07).
  fault_code examples: R-WELDSTK, R-DRESS, R-SERVO, R-BELL, R-TORQUE, C-SKID,
    C-EMS, C-AGV, C-VFD, C-CHAIN.

ANALYTICAL VIEWS (prefer these when they fit the question)
  v_oee / v_oee_by_line          OEE = Availability x Performance x Quality
  v_loss_by_station              downtime hours + scrap units per station
  v_mttr_by_crew                 mean time to repair by crew
  v_rootcause_ranking            defects by root_cause_station
  v_robot_candidates             robots with rising fault trend
  v_yield_by_quarter             yield trend by quarter
  v_summer_thermal               thermal faults per summer

RULES
  - Reply with ONE PostgreSQL SELECT and nothing else - no prose, no markdown
    fences, no JSON. The user never writes SQL; producing it is your job.
  - Default to answering. Comparison, correlation, trend, ranking, and
    "does X relate to Y" questions ARE answerable whenever both quantities live
    in this schema: aggregate each to a common grain (e.g. per line per month)
    and JOIN them, using CTEs, window functions, or statistical aggregates
    (corr, stddev, regr_*, percentile_cont) - all supported by PostgreSQL - so
    the relationship shows up in the rows.
  - Only reply "NOT_ANSWERABLE: <reason>" when a table or column the question
    truly needs is absent from the schema above (e.g. supplier, stock price,
    weather, cost). Never refuse because a question is analytically complex,
    needs a join, or asks for a correlation. When unsure, write the SELECT.
  - Read-only: never write, alter, or use admin/pg_* functions.
  - Always include a sensible ORDER BY; cap detail queries with LIMIT.
  - Use date_trunc / EXTRACT for time grouping. Quarters: date_trunc('quarter', ts).
  - "last quarter" = the most recent full calendar quarter present in the data.
  - downtime is in minutes (downtime_min); divide by 60 for hours.
  - For result summaries, answer only from the supplied rows and SQL.
"""

FEW_SHOT = [
    (
        "Which station lost the most hours on D-crew last quarter?",
        "SELECT station, ROUND(SUM(downtime_min)/60.0, 1) AS downtime_hours\n"
        "FROM fact_fault_events\n"
        "WHERE crew = 'D'\n"
        "  AND date_trunc('quarter', ts) = "
        "(SELECT date_trunc('quarter', MAX(ts)) FROM fact_fault_events)\n"
        "GROUP BY station ORDER BY downtime_hours DESC LIMIT 10;",
    ),
    (
        "What is our overall OEE and its three components?",
        "SELECT availability_pct, performance_pct, quality_pct, oee_pct FROM v_oee;",
    ),
    (
        "Which robots have a rising fault trend?",
        "SELECT asset_id, station, total_faults, faults_prior, faults_recent, trend\n"
        "FROM v_robot_candidates WHERE trend = 'rising'\n"
        "ORDER BY total_faults DESC LIMIT 10;",
    ),
    (
        "How did spot-weld defects change month over month?",
        "SELECT date_trunc('month', ts) AS month, COUNT(*) AS spot_weld_defects\n"
        "FROM fact_defect_events\n"
        "WHERE root_cause_station = 'ST03' OR defect_type ILIKE '%weld%'\n"
        "GROUP BY 1 ORDER BY 1;",
    ),
    (
        "Compare yield by line.",
        "SELECT line, ROUND(AVG(yield_pct)::numeric, 2) AS avg_yield_pct\n"
        "FROM fact_production\n"
        "GROUP BY line ORDER BY avg_yield_pct DESC LIMIT 10;",
    ),
    (
        "Which crew has the slowest mean time to repair, and by how much?",
        "WITH ranked AS (\n"
        "  SELECT crew, mttr_min,\n"
        "         mttr_min - MIN(mttr_min) OVER () AS slower_than_best_min\n"
        "  FROM v_mttr_by_crew\n"
        ")\n"
        "SELECT crew, ROUND(mttr_min::numeric, 1) AS mttr_min,\n"
        "       ROUND(slower_than_best_min::numeric, 1) AS slower_than_best_min\n"
        "FROM ranked ORDER BY mttr_min DESC LIMIT 1;",
    ),
    (
        "Where do most defects originate vs where are they detected?",
        "SELECT root_cause_station, detected_station, COUNT(*) AS defects\n"
        "FROM fact_defect_events\n"
        "GROUP BY root_cause_station, detected_station\n"
        "ORDER BY defects DESC LIMIT 10;",
    ),
    (
        "What were the worst 5 fault codes by total downtime?",
        "SELECT fault_code, fault_desc, ROUND(SUM(downtime_min)/60.0, 1) AS downtime_hours\n"
        "FROM fact_fault_events\n"
        "GROUP BY fault_code, fault_desc ORDER BY downtime_hours DESC LIMIT 5;",
    ),
    (
        "Do months with more fault downtime have lower yield, by line?",
        "WITH fault AS (\n"
        "  SELECT line, date_trunc('month', ts) AS month,\n"
        "         SUM(downtime_min) / 60.0 AS fault_downtime_hours\n"
        "  FROM fact_fault_events GROUP BY line, date_trunc('month', ts)\n"
        "),\n"
        "prod AS (\n"
        "  SELECT line, date_trunc('month', ts) AS month,\n"
        "         AVG(yield_pct) AS avg_yield_pct\n"
        "  FROM fact_production GROUP BY line, date_trunc('month', ts)\n"
        ")\n"
        "SELECT f.line, f.month,\n"
        "       ROUND(f.fault_downtime_hours::numeric, 1) AS fault_downtime_hours,\n"
        "       ROUND(p.avg_yield_pct::numeric, 2) AS avg_yield_pct\n"
        "FROM fault f JOIN prod p ON p.line = f.line AND p.month = f.month\n"
        "ORDER BY f.line, f.month;",
    ),
]

UNANSWERABLE_EXAMPLES = [
    {
        "question": "What was Tesla's stock price last quarter?",
        "reason": "The warehouse contains plant production, faults, defects, maintenance, shifts, assets, and operational events, but no financial market data.",
    },
    {
        "question": "Which supplier caused the most defects?",
        "reason": "The defect table has defect type, line, crew, detected station, and root-cause station, but no supplier field.",
    },
]


def context() -> dict:
    """The schema grounding the browser needs to build a provider request.

    Generation happens client-side (bring-your-own-key), so this is the single
    source of truth for the schema prompt + few-shot examples, served to the
    frontend rather than baked into it."""
    return {
        "system": SCHEMA_PROMPT,
        "examples": [{"question": q, "sql": a} for q, a in FEW_SHOT],
        "unanswerable_examples": UNANSWERABLE_EXAMPLES,
    }
