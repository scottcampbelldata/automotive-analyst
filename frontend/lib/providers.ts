// Multi-provider SQL generation, all client-side. The visitor's key is sent
// directly from the browser to their chosen provider (Anthropic / OpenAI /
// Gemini) and never to this site's backend. Each provider speaks a slightly
// different request/response shape; this module hides that behind generateSQL /
// repairSQL, which return raw SQL text for the backend guardrails to validate.

import type { Creds, Provider } from "./keyStore";

export interface SchemaContext {
  system: string;
  examples: { question: string; sql: string }[];
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
  const messages = [{ role: "system", content: system }, ...turns];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.key}` },
    body: JSON.stringify({ model: creds.model, messages, temperature: 0, max_tokens: 600 }),
  });
  if (!res.ok) throw new Error(await providerError(res, "OpenAI"));
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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
  const raw = await DISPATCH[creds.provider](creds, ctx.system, buildTurns(ctx, question));
  return stripFences(raw);
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
