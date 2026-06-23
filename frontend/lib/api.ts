// Client for the Automotive Analyst backend (on the VPS). The backend never sees
// an API key: it only serves the schema context and validates + runs SQL.
// Set NEXT_PUBLIC_API_BASE in the Cloudflare Pages project, e.g.
//   https://analyst-api.scottcampbell.io
import type { SchemaContext } from "./providers";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8010";

// Hard ceiling so a slow or waking-up backend can't hang the UI forever.
const API_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, { ...init, cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`The analyst API didn't respond within ${API_TIMEOUT_MS / 1000}s. Try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(path, {});
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429)
    throw new Error("You're sending requests too quickly - give it a few seconds.");
  return res.json() as Promise<T>;
}

export interface RunResponse {
  ok: boolean;
  stage?: string;
  error?: string;
  question?: string;
  sql?: string;
  guardrail?: string;
  columns?: string[];
  rows?: Record<string, string | number | null>[];
  row_count?: number;
  viz?: "scalar" | "bar" | "line" | "table" | "empty";
}

export const api = {
  samples: () => get<string[]>("/api/ask/samples"),
  context: () => get<SchemaContext>("/api/ask/context"),
  run: (question: string, sql: string) =>
    post<RunResponse>("/api/ask/run", { question, sql }),
};
