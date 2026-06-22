// API client for the Automotive Analyst backend (on the VPS).
// Set NEXT_PUBLIC_API_BASE in the Cloudflare Pages project, e.g.
//   https://analyst-api.scottcampbell.io
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8010";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return res.json() as Promise<T>;
}

export interface AskResponse {
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
  askSamples: () => get<string[]>("/api/ask/samples"),
  ask: (question: string) => post<AskResponse>("/api/ask", { question }),
};
