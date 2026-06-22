"use client";
import { useEffect, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { api, RunResponse } from "@/lib/api";
import { planQuery, repairSQL, summarizeResult, QueryPlan, SchemaContext } from "@/lib/providers";
import { Creds, PROVIDERS, clearCreds, loadCreds } from "@/lib/keyStore";
import { KeyPanel } from "@/components/KeyPanel";

const DASHBOARD_URL = "https://factory.scottcampbell.io";
const AXIS = { fill: "#8896b4", fontSize: 12 };
const TIP = { background: "#0a0e1a", border: "1px solid #1f2a44", borderRadius: 8 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// SQL date_trunc returns full ISO timestamps (2024-06-01T00:00:00) that are
// ugly on a chart axis. Render those as readable dates; leave everything else
// (numbers, station names, fault codes) exactly as-is.
function formatLabel(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return v;
  const [, y, mo, d, hh, mm] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const midnight = !hh || (hh === "00" && mm === "00");
  if (d === "01" && midnight) return `${month} ${y}`; // month grain
  if (midnight) return `${month} ${Number(d)}, ${y}`; // day grain
  return `${month} ${Number(d)}, ${y} ${hh}:${mm}`; // with time
}

type Phase = "idle" | "planning" | "running" | "repairing" | "summarizing";

function ResultChart({ res }: { res: RunResponse }) {
  const cols = res.columns ?? [];
  const rows = res.rows ?? [];

  if (res.viz === "bar" && cols.length >= 2) {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -10, bottom: 40 }}>
          <CartesianGrid stroke="#1f2a44" vertical={false} />
          <XAxis
            dataKey={cols[0]}
            tick={AXIS}
            angle={-20}
            textAnchor="end"
            interval={0}
            tickFormatter={formatLabel}
          />
          <YAxis tick={AXIS} />
          <Tooltip contentStyle={TIP} labelFormatter={formatLabel} />
          <Bar dataKey={cols[1]} fill="#e0653f" radius={[5, 5, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  if (res.viz === "line" && cols.length >= 2) {
    const yKey = cols.find((c, i) => i > 0 && typeof rows[0][c] === "number") ?? cols[1];
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid stroke="#1f2a44" vertical={false} />
          <XAxis dataKey={cols[0]} tick={AXIS} tickFormatter={formatLabel} />
          <YAxis tick={AXIS} />
          <Tooltip contentStyle={TIP} labelFormatter={formatLabel} />
          <Line dataKey={yKey} stroke="#e6ecf7" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }
  if (res.viz === "scalar") {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cols.map((c) => (
          <div key={c} className="kpi">
            <div className="kpi-value">{String(rows[0][c])}</div>
            <div className="kpi-label">{c.replace(/_/g, " ")}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="overflow-auto max-h-[420px]">
      <table className="data w-full">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left">
            {cols.map((c) => <th key={c} className="py-1 pr-4">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c} className="py-1.5 pr-4">{formatLabel(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  planning: "Checking the warehouse schema and writing SQL...",
  running: "Validating and running read-only...",
  repairing: "Query failed - asking the model to fix it...",
  summarizing: "Writing the answer from the result rows...",
};

export default function Home() {
  const [creds, setCreds] = useState<Creds | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [ctx, setCtx] = useState<SchemaContext | null>(null);
  const [samples, setSamples] = useState<string[]>([]);

  const [q, setQ] = useState("");
  const [res, setRes] = useState<RunResponse | null>(null);
  const [genSql, setGenSql] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [notEnoughData, setNotEnoughData] = useState<string | null>(null);
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string | null>(null);

  const loading = phase !== "idle";
  const providerLabel = creds ? PROVIDERS.find((p) => p.id === creds.provider)?.label : null;

  useEffect(() => {
    setCreds(loadCreds());
    api.samples().then(setSamples).catch(() => setSamples([]));
    api.context().then(setCtx).catch(() => setCtx(null));
  }, []);

  async function run(question: string) {
    if (!question.trim()) return;
    if (!creds) {
      setEditingKey(true);
      return;
    }
    let context = ctx;
    if (!context) {
      try {
        context = await api.context();
        setCtx(context);
      } catch {
        setErr("Could not load the schema context from the API. Is the backend reachable?");
        return;
      }
    }

    setQ(question);
    setRes(null);
    setErr(null);
    setGenSql(null);
    setAnswer(null);
    setNotEnoughData(null);
    setPlan(null);
    setRepaired(false);

    try {
      setPhase("planning");
      const nextPlan = await planQuery(creds, context, question);
      setPlan(nextPlan);
      if (!nextPlan.answerable || !nextPlan.sql) {
        setNotEnoughData(
          nextPlan.reason || "The warehouse does not contain enough data for that question.",
        );
        return;
      }
      const sql = nextPlan.sql;
      setGenSql(sql);

      setPhase("running");
      let r = await api.run(question, sql);

      if (!r.ok && r.stage === "execute") {
        setPhase("repairing");
        try {
          const fixed = await repairSQL(creds, context, question, sql, r.error ?? "");
          setGenSql(fixed);
          const r2 = await api.run(question, fixed);
          if (r2.ok) setRepaired(true);
          r = r2;
        } catch {
          /* keep the original execute error */
        }
      }

      if (r.sql) setGenSql(r.sql); // the exact SQL the server validated/ran
      setRes(r);
      if (r.ok && r.columns && r.rows && r.sql) {
        setPhase("summarizing");
        try {
          setAnswer(await summarizeResult(creds, context, question, r.sql, r.columns, r.rows));
        } catch {
          setAnswer(null);
        }
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <main className="max-w-5xl mx-auto p-6 md:p-8 space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Natural-language analytics · text-to-SQL</div>
          <h1 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">
            Automotive Analyst
          </h1>
          <p className="text-mute text-sm mt-1 max-w-2xl">
            Ask the assembly-plant warehouse a question in plain English. Your model
            writes PostgreSQL, the server validates it through read-only guardrails and
            runs it — and you always see the query behind the answer.
          </p>
        </div>
        <a href={DASHBOARD_URL} className="badge shrink-0" target="_blank" rel="noreferrer">
          Dashboard ↗
        </a>
      </header>

      {/* Key status / management */}
      {creds && !editingKey && (
        <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
          <span className="text-mute">
            Using <span className="text-white">{providerLabel}</span>
            <span className="text-faint"> · {creds.model}</span>
            <span className="text-good"> · key in this tab only</span>
          </span>
          <span className="flex gap-3">
            <button onClick={() => setEditingKey(true)} className="text-mute hover:text-white">
              Change key
            </button>
            <button
              onClick={() => { clearCreds(); setCreds(null); }}
              className="text-mute hover:text-accent"
            >
              Clear
            </button>
          </span>
        </div>
      )}

      {(!creds || editingKey) && (
        <KeyPanel
          initial={creds}
          onSaved={(c) => { setCreds(c); setEditingKey(false); }}
          onCancel={creds ? () => setEditingKey(false) : undefined}
        />
      )}

      {/* Ask box */}
      <div className="card">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run(q)}
            placeholder="e.g. which station lost the most hours on D-crew last quarter?"
            className="flex-1 bg-[var(--panel-2)] border border-edge rounded-lg px-4 py-2.5 text-sm text-white placeholder:text-faint outline-none focus:border-accent"
          />
          <button
            onClick={() => run(q)}
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? "Working…" : creds ? "Ask" : "Add key"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {samples.map((s) => (
            <button
              key={s}
              onClick={() => run(s)}
              disabled={loading}
              className="text-xs text-mute border border-edge rounded-full px-3 py-1 hover:border-accent hover:text-white transition-colors disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
        {loading && <div className="text-xs text-faint mt-3">{PHASE_LABEL[phase]}</div>}
      </div>

      {err && (
        <div className="card">
          <div className="text-accent font-medium mb-1">Couldn&apos;t complete the request</div>
          <p className="text-sm text-mute">{err}</p>
        </div>
      )}

      {notEnoughData && (
        <div className="card">
          <div className="text-accent font-medium mb-1">Not enough data in this warehouse</div>
          <p className="text-sm text-mute">{notEnoughData}</p>
        </div>
      )}

      {(res || genSql) && (
        <div className="card space-y-4">
          {res &&
            (res.ok ? (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="section-title">Answer</div>
                  <span className="flex gap-2">
                    {repaired && (
                      <span className="text-xs text-mute border border-edge rounded-full px-2.5 py-0.5">
                        self-corrected ↻
                      </span>
                    )}
                    <span className="text-xs text-good border border-good/40 rounded-full px-2.5 py-0.5">
                      guardrail: {res.guardrail}
                    </span>
                  </span>
                </div>
                {answer && <p className="text-sm text-[#dce6f7] leading-relaxed">{answer}</p>}
                <ResultChart res={res} />
                <div className="text-xs text-faint">{res.row_count} row(s)</div>
              </>
            ) : (
              <div>
                <div className="text-accent font-medium mb-1">
                  {res.stage === "guardrail"
                    ? "Query blocked by guardrails"
                    : `Could not answer (${res.stage})`}
                </div>
                <p className="text-sm text-mute">{res.error}</p>
              </div>
            ))}

          {genSql && (
            <div>
              <div className="text-xs text-faint uppercase tracking-wider mb-1.5">
                Generated SQL{providerLabel ? ` · ${providerLabel}` : ""}
              </div>
              {plan?.reason && res?.ok && (
                <div className="text-xs text-faint mb-2">{plan.reason}</div>
              )}
              <pre className="bg-[var(--panel-2)] border border-edge rounded-lg p-3 text-xs text-[#cdd7ea] overflow-auto whitespace-pre-wrap">
                {genSql}
              </pre>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="eyebrow mb-2">How it works</div>
        <div className="grid sm:grid-cols-4 gap-3 text-sm">
          {[
            ["1 · Your key", "Your provider key stays in this browser tab and calls Claude / OpenAI / Gemini directly — never our server."],
            ["2 · Generate", "Your model writes one PostgreSQL SELECT, grounded in the star schema served by the API."],
            ["3 · Guardrail", "The server validates it: SELECT-only, single statement, allow-listed tables, LIMIT injected."],
            ["4 · Execute", "Run as a read-only role inside a read-only transaction with a statement timeout. Self-corrects once on error."],
          ].map(([t, d]) => (
            <div key={t} className="border border-edge rounded-lg p-3">
              <div className="text-accent text-xs font-semibold mb-1">{t}</div>
              <div className="text-mute text-xs leading-relaxed">{d}</div>
            </div>
          ))}
        </div>
      </div>

      <footer className="text-xs text-faint pt-4 border-t border-edge">
        Built by Scott Campbell · FastAPI · PostgreSQL · Next.js · Recharts. Bring-your-own-key
        (Claude / OpenAI / Gemini); the key never touches the server. Reads the same warehouse as
        the dashboard, read-only. Data is fully synthetic; no proprietary or employer data.
      </footer>
    </main>
  );
}
