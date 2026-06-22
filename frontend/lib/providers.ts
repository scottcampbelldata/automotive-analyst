// Multi-provider SQL generation, all client-side. The visitor's key is sent
// directly from the browser to their chosen provider (Anthropic / OpenAI /
// Gemini) and never to this site's backend. Each provider speaks a slightly
// different request/response shape; this module hides that behind generateSQL /
// repairSQL, which return raw SQL text for the backend guardrails to validate.

import type { Creds, Provider } from "./keyStore";

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
      'Return JSON only: {"answerable": boolean, "reason": string, "sql": string|null, "chart": "auto"|"bar"|"line"|"scalar"|"table"}.',
  });
  return turns;
}

function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

function exactExamplePlan(ctx: SchemaContext, question: string): QueryPlan | null {
  const normalized = normalizeQuestion(question);
  const example = ctx.examples.find((ex) => normalizeQuestion(ex.question) === normalized);
  if (!example) return null;
  return {
    answerable: true,
    reason: "Answerable from the warehouse schema.",
    sql: example.sql,
    chart: "auto",
  };
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
    body: JSON.stringify({ model: creds.model, max_tokens: 600, system, messages: turns }),
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
      max_output_tokens: 600,
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
      generationConfig: { temperature: 0, maxOutputTokens: 600 },
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

export async function planQuery(
  creds: Creds,
  ctx: SchemaContext,
  question: string,
): Promise<QueryPlan> {
  const exact = exactExamplePlan(ctx, question);
  if (exact) return exact;
  const raw = await DISPATCH[creds.provider](creds, ctx.system, buildPlannerTurns(ctx, question));
  return parseQueryPlan(raw);
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
