"""viz_hint is a pure function that picks how the frontend should render a result."""
from app.agent.runner import viz_hint


def test_empty_when_no_rows():
    assert viz_hint([], []) == "empty"
    assert viz_hint(["a"], []) == "empty"


def test_scalar_for_single_row_few_columns():
    assert viz_hint(["oee_pct", "avail_pct"], [{"oee_pct": 82.1, "avail_pct": 90.0}]) == "scalar"


def test_line_when_a_time_column_is_present():
    rows = [{"month": "2025-01", "cnt": 5}, {"month": "2025-02", "cnt": 8}]
    assert viz_hint(["month", "cnt"], rows) == "line"


def test_bar_for_label_plus_number():
    rows = [{"station": "ST03", "hours": 40}, {"station": "ST06", "hours": 12}]
    assert viz_hint(["station", "hours"], rows) == "bar"


def test_table_fallback_for_wide_results():
    rows = [
        {"station": "ST03", "fault": "R-WELDSTK", "note": "x"},
        {"station": "ST06", "fault": "C-SKID", "note": "y"},
    ]
    assert viz_hint(["station", "fault", "note"], rows) == "table"
