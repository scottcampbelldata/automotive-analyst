"""
Schema grounding for the text-to-SQL agent: a compact, accurate description of
the star schema plus a few worked examples. This is what the model sees; getting
it right is most of what makes generated SQL correct.
"""

SCHEMA_PROMPT = """\
You write PostgreSQL SELECT queries for an automotive final-assembly plant's
analytics warehouse (3 years of data, 2023-2025). Star schema:

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
  - Output ONE PostgreSQL SELECT only. No commentary, no markdown fences.
  - Read-only: never write, alter, or use admin/pg_* functions.
  - Always include a sensible ORDER BY; cap detail queries with LIMIT.
  - Use date_trunc / EXTRACT for time grouping. Quarters: date_trunc('quarter', ts).
  - "last quarter" = the most recent full calendar quarter present in the data.
  - downtime is in minutes (downtime_min); divide by 60 for hours.
"""

FEW_SHOT = [
    (
        "Which station lost the most downtime hours on the night crew?",
        "SELECT station, ROUND(SUM(downtime_min)/60.0,0) AS downtime_hours\n"
        "FROM fact_fault_events WHERE crew = 'D'\n"
        "GROUP BY station ORDER BY downtime_hours DESC LIMIT 10;",
    ),
    (
        "What's our overall OEE and its components?",
        "SELECT availability_pct, performance_pct, quality_pct, oee_pct FROM v_oee;",
    ),
    (
        "Which robots have the most faults and are they getting worse?",
        "SELECT asset_id, station, total_faults, faults_prior, faults_recent, trend\n"
        "FROM v_robot_candidates ORDER BY total_faults DESC LIMIT 10;",
    ),
    (
        "How did paint defects change over time?",
        "SELECT date_trunc('month', ts) AS month, COUNT(*) AS paint_defects\n"
        "FROM fact_defect_events WHERE root_cause_station = 'ST04'\n"
        "GROUP BY 1 ORDER BY 1;",
    ),
    (
        "Which station lost the most hours on D-crew last quarter?",
        "SELECT station, ROUND(SUM(downtime_min)/60.0, 1) AS downtime_hours\n"
        "FROM fact_fault_events\n"
        "WHERE crew = 'D'\n"
        "  AND date_trunc('quarter', ts) = "
        "(SELECT date_trunc('quarter', MAX(ts)) FROM fact_fault_events)\n"
        "GROUP BY station ORDER BY downtime_hours DESC LIMIT 10;",
    ),
]


def build_messages(question: str):
    """Few-shot user/assistant turns + the live question."""
    msgs = []
    for q, a in FEW_SHOT:
        msgs.append({"role": "user", "content": q})
        msgs.append({"role": "assistant", "content": a})
    msgs.append({"role": "user", "content": question})
    return msgs


def build_repair_messages(question: str, bad_sql: str, error: str):
    """One corrective turn: show the model its failed SQL and the DB error so it
    can return a fixed single SELECT (self-correction)."""
    msgs = build_messages(question)
    msgs.append({"role": "assistant", "content": bad_sql})
    msgs.append({
        "role": "user",
        "content": (
            f"That query failed with this PostgreSQL error:\n{error}\n\n"
            "Return a corrected single SELECT that fixes the error. "
            "Output only SQL, no commentary."
        ),
    })
    return msgs
