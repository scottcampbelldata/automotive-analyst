# Schema-Bound Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users ask any question answerable from the automotive warehouse schema and receive a grounded text answer, SQL, validated results, and chart/table output, with clear "not enough data" responses outside the schema.

**Architecture:** Keep the existing BYOK browser flow. Add a structured planning step before SQL execution, a result summarization step after execution, and a normal UI state for unanswerable questions. The backend remains the schema-context and read-only execution authority.

**Tech Stack:** Next.js 14, React 18, TypeScript, Recharts, FastAPI, pytest, PostgreSQL read-only SQL guardrails.

## Global Constraints

- Provider API keys stay in browser session storage and are never sent to the backend.
- The backend only validates and executes read-only SQL.
- Questions outside the warehouse schema render as "not enough data", not provider failures.
- No live provider keys are required for automated tests.
- No database migrations or external web data.

---

### Task 1: Backend Schema Contract

**Files:**
- Modify: `backend/app/agent/schema_context.py`
- Modify: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: existing `context() -> dict` endpoint shape with `system` and `examples`.
- Produces: schema prompt rules for structured planning, answerability, SQL repair, and result summaries.

- [ ] **Step 1: Run the current targeted backend test**

Run: `python -m pytest backend/tests/test_api.py::test_sample_questions_have_exact_guardrailed_examples -q`

Expected before implementation: FAIL with missing sample examples.

- [ ] **Step 2: Update `SCHEMA_PROMPT`**

In `backend/app/agent/schema_context.py`, replace the opening and rules section so the prompt includes this contract:

```python
SCHEMA_PROMPT = """\
You are a schema-bound analyst for an automotive final-assembly plant's
analytics warehouse (3 years of data, 2023-2025). Your job is to decide whether
a question can be answered from this schema, write safe PostgreSQL SELECTs for
answerable questions, and explain clearly when the warehouse does not contain
enough data.

Only use the tables, columns, analytical views, and reference values listed
below. Do not invent columns, metrics, tables, thresholds, or outside facts.
...
RULES
  - For planning, return JSON only with answerable, reason, sql, and chart.
  - answerable=false when the question needs data outside this schema.
  - If answerable=false, sql must be null and reason must be a concise warehouse
    limitation, not a generic apology.
  - If answerable=true, sql must be ONE PostgreSQL SELECT only.
  - Read-only: never write, alter, or use admin/pg_* functions.
  - Always include a sensible ORDER BY; cap detail queries with LIMIT.
  - Use date_trunc / EXTRACT for time grouping. Quarters: date_trunc('quarter', ts).
  - "last quarter" = the most recent full calendar quarter present in the data.
  - downtime is in minutes (downtime_min); divide by 60 for hours.
  - For result summaries, answer only from the supplied rows and SQL.
"""
```

Keep the existing schema body intact between the opening and rules.

- [ ] **Step 3: Expand `FEW_SHOT` to cover all visible samples**

Make sure `FEW_SHOT` contains exact question strings from `SAMPLES` in `backend/app/routers/ask.py`, including:

```python
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
```

- [ ] **Step 4: Add unanswerable examples to `context()`**

Add a second list named `UNANSWERABLE_EXAMPLES`:

```python
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
```

Return it from `context()` as `"unanswerable_examples": UNANSWERABLE_EXAMPLES`.

- [ ] **Step 5: Update backend test expectations**

In `backend/tests/test_api.py`, extend `test_context_endpoint_serves_schema_and_examples`:

```python
assert isinstance(body["unanswerable_examples"], list)
assert {"question", "reason"} <= body["unanswerable_examples"][0].keys()
```

- [ ] **Step 6: Run backend API tests**

Run: `python -m pytest backend/tests/test_api.py -q`

Expected: PASS.

- [ ] **Step 7: Commit backend schema contract**

Run:

```bash
git add backend/app/agent/schema_context.py backend/tests/test_api.py
git commit -m "Expand analyst schema contract"
```

### Task 2: Provider Planning and Summary API

**Files:**
- Modify: `frontend/lib/providers.ts`

**Interfaces:**
- Consumes: `SchemaContext` from backend, now optionally including `unanswerable_examples`.
- Produces: `QueryPlan`, `planQuery`, `summarizeResult`, and existing `repairSQL`.

- [ ] **Step 1: Add TypeScript interfaces**

Add near `SchemaContext`:

```ts
export interface SchemaContext {
  system: string;
  examples: { question: string; sql: string }[];
  unanswerable_examples?: { question: string; reason: string }[];
}

export interface QueryPlan {
  answerable: boolean;
  reason: string;
  sql: string | null;
  chart: "auto" | "bar" | "line" | "scalar" | "table";
}
```

Remove the old `SchemaContext` definition.

- [ ] **Step 2: Add JSON extraction tests manually with TypeScript typecheck**

Since this repo has no frontend test runner, implement exported pure functions and validate through `npm run build`.

Add:

```ts
function extractJsonObject(raw: string): string {
  const trimmed = stripFences(raw);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The model did not return a JSON object.");
  }
  return trimmed.slice(start, end + 1);
}

function parseQueryPlan(raw: string): QueryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new Error("The model returned invalid JSON while planning the query.");
  }
  const plan = parsed as Partial<QueryPlan>;
  if (typeof plan.answerable !== "boolean") {
    throw new Error("The model plan is missing answerable.");
  }
  const chart = ["auto", "bar", "line", "scalar", "table"].includes(String(plan.chart))
    ? (plan.chart as QueryPlan["chart"])
    : "auto";
  if (!plan.answerable) {
    return {
      answerable: false,
      reason: String(plan.reason || "The warehouse does not contain enough data for that question."),
      sql: null,
      chart,
    };
  }
  if (typeof plan.sql !== "string" || !plan.sql.trim()) {
    throw new Error("The model marked the question answerable but did not return SQL.");
  }
  return {
    answerable: true,
    reason: String(plan.reason || ""),
    sql: stripFences(plan.sql),
    chart,
  };
}
```

- [ ] **Step 3: Add planning prompt builders**

Add:

```ts
function buildPlannerTurns(ctx: SchemaContext, question: string): Turn[] {
  const turns: Turn[] = [];
  for (const ex of ctx.examples) {
    turns.push({ role: "user", content: `Plan this warehouse question:\n${ex.question}` });
    turns.push({
      role: "assistant",
      content: JSON.stringify({
        answerable: true,
        reason: "Answerable from the warehouse schema.",
        sql: ex.sql,
        chart: "auto",
      }),
    });
  }
  for (const ex of ctx.unanswerable_examples ?? []) {
    turns.push({ role: "user", content: `Plan this warehouse question:\n${ex.question}` });
    turns.push({
      role: "assistant",
      content: JSON.stringify({
        answerable: false,
        reason: ex.reason,
        sql: null,
        chart: "table",
      }),
    });
  }
  turns.push({
    role: "user",
    content:
      `Plan this warehouse question:\n${question}\n\n` +
      "Return JSON only: {\"answerable\": boolean, \"reason\": string, \"sql\": string|null, \"chart\": \"auto\"|\"bar\"|\"line\"|\"scalar\"|\"table\"}.",
  });
  return turns;
}
```

- [ ] **Step 4: Export `planQuery`**

Add:

```ts
export async function planQuery(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
): Promise<QueryPlan> {
  const raw = await DISPATCH[creds.provider](creds, ctx.system, buildPlannerTurns(ctx, question));
  return parseQueryPlan(raw);
}
```

- [ ] **Step 5: Add result summarization**

Add:

```ts
export async function summarizeResult(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, string | number | null>[],
): Promise<string> {
  const previewRows = rows.slice(0, 25);
  const turns: Turn[] = [
    {
      role: "user",
      content:
        "Answer this warehouse question using only the SQL result below.\n" +
        `Question: ${question}\n` +
        `SQL: ${sql}\n` +
        `Columns: ${JSON.stringify(columns)}\n` +
        `Rows: ${JSON.stringify(previewRows)}\n` +
        `Total rows returned: ${rows.length}\n\n` +
        "Write 1-3 concise sentences. If the rows are empty, say the query returned no matching records.",
    },
  ];
  const raw = await DISPATCH[creds.provider](creds, ctx.system, turns);
  return stripFences(raw);
}
```

- [ ] **Step 6: Keep old `generateSQL` as compatibility wrapper**

Change `generateSQL` to:

```ts
export async function generateSQL(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
): Promise<string> {
  const plan = await planQuery(creds, ctx, question);
  if (!plan.answerable || !plan.sql) {
    throw new Error(plan.reason || "The warehouse does not contain enough data for that question.");
  }
  return plan.sql;
}
```

- [ ] **Step 7: Run frontend build**

Run: `npm run build` from `frontend`.

Expected: PASS.

- [ ] **Step 8: Commit provider analyst API**

Run:

```bash
git add frontend/lib/providers.ts
git commit -m "Add schema-bound query planning"
```

### Task 3: Frontend Analyst UI Flow

**Files:**
- Modify: `frontend/app/page.tsx`

**Interfaces:**
- Consumes: `planQuery`, `repairSQL`, `summarizeResult`, `QueryPlan`.
- Produces: UI states for grounded answer text, not-enough-data, chart/table, SQL, and repair feedback.

- [ ] **Step 1: Update imports**

Change:

```ts
import { generateSQL, repairSQL, SchemaContext } from "@/lib/providers";
```

to:

```ts
import { planQuery, repairSQL, summarizeResult, SchemaContext, QueryPlan } from "@/lib/providers";
```

- [ ] **Step 2: Expand phase type and labels**

Change:

```ts
type Phase = "idle" | "generating" | "running" | "repairing";
```

to:

```ts
type Phase = "idle" | "planning" | "running" | "repairing" | "summarizing";
```

Set labels:

```ts
const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  planning: "Checking the warehouse schema and writing SQL...",
  running: "Validating and running read-only...",
  repairing: "Query failed - asking the model to fix it...",
  summarizing: "Writing the answer from the result rows...",
};
```

- [ ] **Step 3: Add UI state**

Add:

```ts
const [answer, setAnswer] = useState<string | null>(null);
const [notEnoughData, setNotEnoughData] = useState<string | null>(null);
const [plan, setPlan] = useState<QueryPlan | null>(null);
```

Clear these at the start of `run()`.

- [ ] **Step 4: Replace generation logic in `run()`**

Replace:

```ts
setPhase("generating");
const sql = await generateSQL(creds, context, question);
setGenSql(sql);
```

with:

```ts
setPhase("planning");
const nextPlan = await planQuery(creds, context, question);
setPlan(nextPlan);
if (!nextPlan.answerable || !nextPlan.sql) {
  setNotEnoughData(nextPlan.reason || "The warehouse does not contain enough data for that question.");
  return;
}
const sql = nextPlan.sql;
setGenSql(sql);
```

- [ ] **Step 5: Add summarization after successful execution**

After `setRes(r);`, add:

```ts
if (r.ok && r.columns && r.rows && r.sql) {
  setPhase("summarizing");
  try {
    setAnswer(await summarizeResult(creds, context, question, r.sql, r.columns, r.rows));
  } catch {
    setAnswer(null);
  }
}
```

- [ ] **Step 6: Render not-enough-data state**

Add before the error card:

```tsx
{notEnoughData && (
  <div className="card">
    <div className="text-accent font-medium mb-1">Not enough data in this warehouse</div>
    <p className="text-sm text-mute">{notEnoughData}</p>
  </div>
)}
```

- [ ] **Step 7: Render answer text first**

Inside successful `res.ok` rendering, above `ResultChart`, add:

```tsx
{answer && <p className="text-sm text-[#dce6f7] leading-relaxed">{answer}</p>}
```

- [ ] **Step 8: Mention plan reason only when useful**

Near the generated SQL heading, if `plan?.reason` exists and `res?.ok`, render:

```tsx
{plan?.reason && (
  <div className="text-xs text-faint mb-2">{plan.reason}</div>
)}
```

- [ ] **Step 9: Run frontend build**

Run: `npm run build` from `frontend`.

Expected: PASS.

- [ ] **Step 10: Commit UI flow**

Run:

```bash
git add frontend/app/page.tsx
git commit -m "Show grounded analyst answers"
```

### Task 4: Final Validation

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified branch ready for user review or push.

- [ ] **Step 1: Run backend tests**

Run: `python -m pytest backend/tests -q`

Expected: all tests pass.

- [ ] **Step 2: Run frontend build**

Run: `npm run build` from `frontend`.

Expected: build completes successfully.

- [ ] **Step 3: Inspect git diff**

Run: `git status -sb` and `git log --oneline -5`.

Expected: only intentional commits are present and working tree is clean.

## Self-Review

- Spec coverage: Tasks cover schema contract, provider planning, result summarization, UI not-enough-data state, SQL/results/charts, and validation.
- Placeholder scan: No TBD/TODO placeholders are present.
- Type consistency: `QueryPlan`, `SchemaContext`, `planQuery`, `repairSQL`, and `summarizeResult` names match across tasks.
