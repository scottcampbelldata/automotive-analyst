// Multi-provider SQL generation, all client-side. The visitor's key is sent
// directly from the browser to their chosen provider (Anthropic / OpenAI /
// Gemini) and never to this site's backend. Each provider speaks a slightly
// different request/response shape; this module hides that behind planQuery /
// repairSQL / summarizeResult.
//
// The model does ALL the SQL work: the user only ever asks a plain-English
// question. The model replies with either one PostgreSQL SELECT (the normal
// case) or a `NOT_ANSWERABLE: <reason>` sentinel when the question needs data
// the warehouse doesn't have. We never ask the user for SQL, and we never make
// the model wrap its SQL in JSON — emitting SQL is what these models are
// reliable at; wrapping it in an escaped JSON envelope is what kept truncating
// and breaking on longer queries.

import type { Creds, Provider } from "./keyStore";

// We don't cap output tokens — a truncated reply is worse than a long one.
// OpenAI and Gemini let us omit the cap entirely (model default). Anthropic's
// Messages API requires max_tokens, so we send the largest value its current
// models accept (64K covers Haiku/Sonnet 4.x; Opus allows more).
const ANTHROPIC_MAX_TOKENS = 64000;

const NOT_ANSWERABLE = "NOT_ANSWERABLE:";

export interface SchemaContext {
  system: string;
  examples: { question: string; sql: string }[];
  unanswerable_examples?: { question: string; reason: string }[];
}

export interface QueryPlan {
  answerable: boolean;
  reason: string;
  sql: string | null;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function buildTurns(ctx: SchemaContext, question: string): Turn[] {
  const turns: Turn[] = [];
  for (const ex of ctx.examples) {
    turns.push({ role: "user", content: ex.question });
    turns.push({ role: "assistant", content: ex.sql });
  }
  turns.push({ role: "user", content: question });
  return turns;
}

// Few-shot that teaches both outcomes: answerable questions -> one SELECT,
// out-of-schema questions -> the NOT_ANSWERABLE sentinel. No JSON envelope.
function buildPlannerTurns(ctx: SchemaContext, question: string): Turn[] {
  const turns: Turn[] = [];
  for (const ex of ctx.examples) {
    turns.push({ role: "user", content: ex.question });
    turns.push({ role: "assistant", content: ex.sql });
  }
  for (const ex of ctx.unanswerable_examples ?? []) {
    turns.push({ role: "user", content: ex.question });
    turns.push({ role: "assistant", content: `${NOT_ANSWERABLE} ${ex.reason}` });
  }
  turns.push({ role: "user", content: question });
  return turns;
}

function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

function exactExamplePlan(ctx: SchemaContext, question: string): QueryPlan | null {
  const normalized = normalizeQuestion(question);
  const example = ctx.examples.find((ex) => normalizeQuestion(ex.question) === normalized);
  if (!example) return null;
  return { answerable: true, reason: "Answerable from the warehouse schema.", sql: example.sql };
}

function buildRepairTurns(
  ctx: SchemaContext,
  question: string,
  badSql: string,
  error: string,
): Turn[] {
  const turns = buildTurns(ctx, question);
  turns.push({ role: "assistant", content: badSql });
  turns.push({
    role: "user",
    content:
      `That query failed with this PostgreSQL error:\n${error}\n\n` +
      "Return a corrected single SELECT that fixes the error. Output only SQL, no commentary.",
  });
  return turns;
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:sql)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function extractSql(raw: string): string | null {
  const cleaned = stripFences(raw);
  const match = cleaned.match(/\b(with|select)\b[\s\S]*/i);
  if (!match) return null;
  return match[0].trim();
}

// Turn whatever the model said into a plan. SQL wins: if the response contains
// a SELECT, the model did its job. Otherwise, surface the NOT_ANSWERABLE reason
// (or a default) so the UI can say "not enough data" — never an internal error.
function interpretPlan(raw: string): QueryPlan {
  const sql = extractSql(raw);
  if (sql) return { answerable: true, reason: "", sql };
  const cleaned = stripFences(raw);
  const reason = cleaned.match(/NOT_ANSWERABLE\s*:?\s*([\s\S]*)/i)?.[1]?.trim();
  return {
    answerable: false,
    reason: reason || "The warehouse does not contain enough data for that question.",
    sql: null,
  };
}

async function providerError(res: Response, name: string): Promise<string> {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message ?? (j?.error ? JSON.stringify(j.error) : "");
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401 || res.status === 403)
    return `${name} rejected your API key (${res.status}). Check the key and that it can use this model.`;
  if (res.status === 429)
    return `${name} rate-limited the request (429). Wait a moment and try again.`;
  return `${name} error ${res.status}: ${detail || res.statusText}`;
}

async function callAnthropic(creds: Creds, system: string, turns: Turn[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.key,
      "anthropic-version": "2023-06-01",
      // Required to allow calling the Messages API directly from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: creds.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system,
      messages: turns,
    }),
  });
  if (!res.ok) throw new Error(await providerError(res, "Anthropic"));
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

async function callOpenAI(creds: Creds, system: string, turns: Turn[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.key}` },
    body: JSON.stringify({
      model: creds.model,
      instructions: system,
      input: turns,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
    }),
  });
  if (!res.ok) throw new Error(await providerError(res, "OpenAI"));
  const data = await res.json();
  if (typeof data.output_text === "string") return data.output_text;
  const output = data.output ?? [];
  return output
    .flatMap((item: { content?: { type?: string; text?: string }[] }) => item.content ?? [])
    .filter((part: { type?: string; text?: string }) => part.type === "output_text")
    .map((part: { text?: string }) => part.text ?? "")
    .join("");
}

async function callGemini(creds: Creds, system: string, turns: Turn[]): Promise<string> {
  const contents = turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));
  // Key goes in a header, not the URL query string — so it can't land in any
  // URL log and stays consistent with the other providers.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${creds.model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": creds.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(await providerError(res, "Gemini"));
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

const DISPATCH: Record<Provider, (c: Creds, s: string, t: Turn[]) => Promise<string>> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
};

export async function planQuery(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
): Promise<QueryPlan> {
  const exact = exactExamplePlan(ctx, question);
  if (exact) return exact;
  const raw = await DISPATCH[creds.provider](creds, ctx.system, buildPlannerTurns(ctx, question));
  return interpretPlan(raw);
}

export async function repairSQL(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
  badSql: string,
  error: string,
): Promise<string> {
  const raw = await DISPATCH[creds.provider](
    creds,
    ctx.system,
    buildRepairTurns(ctx, question, badSql, error),
  );
  return stripFences(raw);
}

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
