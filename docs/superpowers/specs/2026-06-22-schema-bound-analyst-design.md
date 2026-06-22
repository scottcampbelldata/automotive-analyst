# Schema-Bound Analyst Design

## Goal

Turn Automotive Analyst from a sample-question SQL demo into a schema-bound analyst: users can ask any question answerable from the warehouse schema and receive a plain-English answer, SQL, validated results, and a chart or table. If the warehouse does not contain enough information, the app must say so clearly instead of inventing an answer.

## Scope

The feature stays within the existing bring-your-own-key browser architecture. Provider keys remain in session storage and are sent directly from the browser to Anthropic, OpenAI, or Gemini. The backend continues to serve schema context and execute only validated read-only SQL.

The app answers questions from the existing automotive warehouse schema only. It does not browse the web, answer general knowledge questions, or infer facts that are not represented by the schema or returned rows.

## Architecture

The frontend becomes a small analyst pipeline:

1. Build an answerability-and-SQL request from the schema context and user question.
2. Ask the selected provider for structured JSON with `answerable`, `reason`, `sql`, and `chart`.
3. If `answerable` is false, show a "Not enough data" message with the model's schema-grounded reason.
4. If `answerable` is true, send the SQL to the backend `/api/ask/run` endpoint.
5. If execution fails, ask the model to repair the SQL using the database error and run the repaired SQL once.
6. Ask the model to summarize the final result rows into a concise text answer grounded only in those rows.
7. Render text answer first, then chart/table, then generated SQL.

The backend remains the source of truth for schema grounding. Its schema prompt must describe the analyst contract, not just SQL syntax, including when to decline a question.

## Components

`backend/app/agent/schema_context.py`

Expands the prompt from "write one SELECT" to "decide answerability, write safe SQL, and explain limits." It keeps concrete schema details and examples. Examples should include both answerable questions and unanswerable questions so providers learn to decline outside-schema requests.

`frontend/lib/providers.ts`

Owns provider-specific request/response shapes. It will expose:

- `planQuery(creds, ctx, question): Promise<QueryPlan>`
- `repairSQL(creds, ctx, question, badSql, error): Promise<string>`
- `summarizeResult(creds, ctx, question, sql, columns, rows): Promise<string>`

`QueryPlan` is a TypeScript interface:

```ts
export interface QueryPlan {
  answerable: boolean;
  reason: string;
  sql: string | null;
  chart: "auto" | "bar" | "line" | "scalar" | "table";
}
```

Provider output parsing must tolerate markdown fences and extra text by extracting the first JSON object. Invalid JSON should raise a clear provider error.

`frontend/app/page.tsx`

Orchestrates the pipeline and adds UI state for text answers and not-enough-data responses. Existing result rendering remains, but answer text becomes the primary output when available.

`backend/tests/test_api.py`

Adds coverage that visible samples are represented in schema examples where useful and that example SQL passes guardrails. Backend tests continue to verify guardrails and execution contracts.

Frontend validation uses `npm run build`. Backend validation uses `python -m pytest backend/tests`.

## Data Flow

For answerable questions:

`question -> planQuery -> QueryPlan.sql -> /api/ask/run -> rows -> summarizeResult -> UI answer + chart + SQL`

For unanswerable questions:

`question -> planQuery -> QueryPlan.answerable=false -> UI "Not enough data" + reason`

For SQL execution errors:

`QueryPlan.sql -> /run execute error -> repairSQL -> /run -> rows or visible error`

## Error Handling

Provider authentication, rate limit, and malformed-output errors stay visible to the user. SQL guardrail rejections show "Query blocked by guardrails" and the reason. Execution errors trigger one repair attempt; if repair fails, the UI shows the final backend error and the last SQL.

Questions outside the warehouse schema must not be treated as provider errors. They render as a normal "Not enough data in this warehouse" state.

## UI Requirements

The user should see:

- Current provider and model.
- A text answer when the query succeeds.
- A clear "Not enough data" response when outside schema.
- A chart or table based on backend `viz` plus optional model `chart` preference.
- Generated SQL beneath the answer.
- Existing sample chips remain useful but are no longer the only reliable path.

The UI should avoid exposing implementation narration or prompting instructions.

## Testing

Tests should cover:

- Query plan JSON parsing with plain JSON, fenced JSON, and text-wrapped JSON.
- Unanswerable question planning.
- Page-level behavior through build/type checks.
- Backend schema examples and guardrails.
- Existing backend API and guardrail tests.

No live provider API keys are required for automated tests.

## Non-Goals

- No backend storage or handling of provider API keys.
- No new database tables or migrations.
- No web search or external data retrieval.
- No full agent memory or conversation history beyond the current question.
