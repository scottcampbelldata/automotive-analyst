"""
End-to-end tests of the HTTP surface (DB mocked). Covers the contract the
frontend depends on: samples, schema context, and the guardrail/execute branches
of /run.
"""


def test_samples_endpoint(client):
    r = client.get("/api/ask/samples")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list) and len(body) > 0


def test_context_endpoint_serves_schema_and_examples(client):
    r = client.get("/api/ask/context")
    assert r.status_code == 200
    body = r.json()
    assert "system" in body and "PostgreSQL" in body["system"]
    assert isinstance(body["examples"], list) and body["examples"]
    assert {"question", "sql"} <= body["examples"][0].keys()
    assert isinstance(body["unanswerable_examples"], list)
    assert {"question", "reason"} <= body["unanswerable_examples"][0].keys()


def test_sample_questions_have_exact_guardrailed_examples(client):
    samples = client.get("/api/ask/samples").json()
    examples = {
        item["question"]: item["sql"]
        for item in client.get("/api/ask/context").json()["examples"]
    }

    missing = [sample for sample in samples if sample not in examples]
    assert missing == []

    for sample in samples:
        ok, msg, _sql = client._ask.validate_sql(examples[sample])
        assert ok, f"{sample}: {msg}"


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "db": True}


def test_run_rejects_bad_sql_at_guardrail(client):
    # never reaches the DB; guardrails reject it
    r = client.post("/api/ask/run", json={"sql": "DROP TABLE dim_asset", "question": "x"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and body["stage"] == "guardrail"
    assert body["guardrail"] == "rejected"


def test_run_executes_valid_sql(client):
    async def fake_run(sql, *a, **k):
        return ["station", "hours"], [
            {"station": "ST03", "hours": 40},
            {"station": "ST06", "hours": 12},
        ]

    client._ask.run_readonly = fake_run
    r = client.post(
        "/api/ask/run",
        json={"sql": "SELECT station, SUM(downtime_min) AS hours FROM fact_fault_events GROUP BY station",
              "question": "which station?"},
    )
    body = r.json()
    assert body["ok"] is True
    assert body["columns"] == ["station", "hours"]
    assert body["row_count"] == 2
    assert body["viz"] == "bar"
    assert "LIMIT" in body["sql"]  # guardrail injected a LIMIT


def test_run_surfaces_db_errors(client):
    async def boom(sql, *a, **k):
        raise RuntimeError('column "nope" does not exist')

    client._ask.run_readonly = boom
    r = client.post("/api/ask/run", json={"sql": "SELECT nope FROM v_oee", "question": "q"})
    body = r.json()
    assert body["ok"] is False and body["stage"] == "execute"
    assert "does not exist" in body["error"]


def test_run_rejects_oversized_sql(client):
    r = client.post("/api/ask/run", json={"sql": "SELECT 1 FROM v_oee " + "x" * 5000})
    assert r.status_code == 422  # pydantic max_length


def test_run_requires_sql(client):
    r = client.post("/api/ask/run", json={"question": "no sql here"})
    assert r.status_code == 422
