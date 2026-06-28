"use client";
import { useEffect, useState } from "react";
import { api, RunResponse } from "@/lib/api";
import { planQuery, repairSQL, summarizeResult, QueryPlan, SchemaContext } from "@/lib/providers";
import { Creds, PROVIDERS, clearCreds, loadCreds } from "@/lib/keyStore";
import { KeyPanel } from "@/components/KeyPanel";
import { ResultChart } from "@/components/ResultChart";
import { ThemeToggle } from "@/components/ThemeToggle";

const DASHBOARD_URL = "https://factory.scottcampbell.io";

type Phase = "idle" | "planning" | "running" | "repairing" | "summarizing";
type Lamp = "off" | "amber" | "green" | "red";

// Shown when the API's sample list is unreachable (e.g. backend offline) so the
// console is never an empty prompt. Replaced by server samples once they load.
const FALLBACK_SAMPLES = [
  "Which station lost the most hours on D-crew last quarter?",
  "Top 5 defect types by count this year",
  "Daily throughput trend for the body shop",
  "Average downtime per shift by crew",
];

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  planning: "Checking the warehouse schema and writing SQL...",
  running: "Validating and running read-only...",
  repairing: "Query failed - asking the model to fix it...",
  summarizing: "Writing the answer from the result rows...",
};

/** Map the live pipeline state onto andon lamps. */
function andonLamps(phase: Phase, res: RunResponse | null) {
  let gen: Lamp = "off", guard: Lamp = "off", exec: Lamp = "off";
  if (phase === "planning") {
    gen = "amber";
  } else if (phase === "running") {
    gen = "green"; guard = "green"; exec = "amber";
  } else if (phase === "repairing") {
    gen = "green"; guard = "green"; exec = "red";
  } else if (phase === "summarizing") {
    gen = "green"; guard = "green"; exec = "green";
  } else if (res) {
    if (res.ok) {
      gen = "green"; guard = "green"; exec = "green";
    } else if (res.stage === "guardrail") {
      gen = "green"; guard = "red";
    } else if (res.stage === "execute") {
      gen = "green"; guard = "green"; exec = "red";
    } else {
      gen = "red";
    }
  }
  return { gen, guard, exec };
}

function AndonSeg({ name, lamp, pulse }: { name: string; lamp: Lamp; pulse?: boolean }) {
  const live = lamp !== "off";
  return (
    <div className={`andon-seg${live ? " is-live" : ""}`}>
      <span className={`lamp ${lamp}${pulse ? " pulse" : ""}`} />
      <span className="andon-name">{name}</span>
    </div>
  );
}

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
  const { gen, guard, exec } = andonLamps(phase, res);
  const showRepair = phase === "repairing" || repaired;

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
    <main className="max-w-5xl mx-auto p-6 md:p-8 space-y-5">
      {/* Control-console header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow mb-2">Assembly-line analytics &middot; text-to-SQL console</div>
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-strong tracking-tight leading-none">
            Automotive Analyst
          </h1>
          <p className="text-mute text-sm mt-3 max-w-2xl leading-relaxed">
            Ask the assembly-plant warehouse a question in plain English. Your model
            writes PostgreSQL, the server validates it through read-only guardrails and
            runs it, and you always see the query behind the answer.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex gap-2">
            <ThemeToggle />
            <a href={DASHBOARD_URL} className="badge" target="_blank" rel="noreferrer">
              Factory dashboard &#8599;
            </a>
          </div>
          <span className="badge">
            <span className="dot" /> read-only &middot; live
          </span>
        </div>
      </header>

      {/* Key status / management */}
      {creds && !editingKey && (
        <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
          <span className="text-mute mono text-xs">
            <span className="text-faint">PROVIDER </span>
            <span className="text-strong">{providerLabel}</span>
            <span className="text-faint"> &middot; {creds.model}</span>
            <span className="text-good"> &middot; key held in this tab only</span>
          </span>
          <span className="flex gap-3 text-xs">
            <button onClick={() => setEditingKey(true)} className="text-mute hover:text-strong transition-colors">
              Change key
            </button>
            <button
              onClick={() => { clearCreds(); setCreds(null); }}
              className="text-mute hover:text-bad transition-colors"
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

      {/* Ask console */}
      <div className="card space-y-4">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run(q)}
            placeholder="e.g. which station lost the most hours on D-crew last quarter?"
            className="field flex-1"
          />
          <button
            onClick={() => run(q)}
            disabled={loading}
            className="btn-primary px-5 text-sm whitespace-nowrap"
          >
            {loading ? "Working..." : creds ? "Run query" : "Add key"}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {(samples.length ? samples : FALLBACK_SAMPLES).map((s) => (
            <button key={s} onClick={() => run(s)} disabled={loading} className="chip">
              {s}
            </button>
          ))}
        </div>

        {/* Andon rail - lights up as the pipeline runs */}
        <div>
          <div className="andon">
            <AndonSeg name="Generate" lamp={gen} pulse={phase === "planning"} />
            <AndonSeg name="Guardrail" lamp={guard} />
            <AndonSeg name="Execute" lamp={exec} pulse={phase === "running"} />
            {showRepair && (
              <AndonSeg
                name="Self-correct"
                lamp={phase === "repairing" ? "amber" : "green"}
                pulse={phase === "repairing"}
              />
            )}
          </div>
          {loading && <div className="text-xs text-faint mono mt-2">{PHASE_LABEL[phase]}</div>}
        </div>
      </div>

      {err && (
        <div className="card">
          <div className="text-bad font-medium mb-1">Couldn&apos;t complete the request</div>
          <p className="text-sm text-mute">{err}</p>
        </div>
      )}

      {notEnoughData && (
        <div className="card">
          <div className="text-warn font-medium mb-1">Not enough data in this warehouse</div>
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
                      <span className="badge" style={{ color: "var(--warn)" }}>
                        <span className="lamp amber" style={{ boxShadow: "none" }} /> self-corrected
                      </span>
                    )}
                    <span className="badge" style={{ color: "var(--good)" }}>
                      <span className="lamp green" style={{ boxShadow: "none" }} /> guardrail: {res.guardrail}
                    </span>
                  </span>
                </div>
                {answer && <p className="text-sm text-ink leading-relaxed">{answer}</p>}
                <ResultChart res={res} />
                <div className="text-xs text-faint mono">{res.row_count} row(s) returned</div>
              </>
            ) : (
              <div>
                <div className="text-bad font-medium mb-1">
                  {res.stage === "guardrail"
                    ? "Query blocked by guardrails"
                    : `Could not answer (${res.stage})`}
                </div>
                <p className="text-sm text-mute">{res.error}</p>
              </div>
            ))}

          {genSql && (
            <div>
              <div className="eyebrow mb-2" style={{ color: "var(--faint)" }}>
                Generated SQL{providerLabel ? ` · ${providerLabel}` : ""}
              </div>
              {plan?.reason && res?.ok && (
                <div className="text-xs text-faint mb-2">{plan.reason}</div>
              )}
              <pre className="sql">{genSql}</pre>
            </div>
          )}
        </div>
      )}

      {/* How it works - a real four-station sequence */}
      <div className="card">
        <div className="eyebrow mb-3">Line sequence &middot; how a question becomes an answer</div>
        <div className="grid sm:grid-cols-4 gap-3 text-sm">
          {[
            ["01", "Your key", "Your provider key stays in this browser tab and calls Claude / OpenAI / Gemini directly, never our server."],
            ["02", "Generate", "Your model writes one PostgreSQL SELECT, grounded in the star schema served by the API."],
            ["03", "Guardrail", "The server validates it: SELECT-only, single statement, allow-listed tables, LIMIT injected."],
            ["04", "Execute", "Run as a read-only role inside a read-only transaction with a statement timeout. Self-corrects once on error."],
          ].map(([n, t, d]) => (
            <div key={n} className="border border-edge rounded-[10px] p-3.5 bg-[var(--panel-2)]">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="font-display text-accent text-lg font-semibold leading-none">{n}</span>
                <span className="text-strong text-xs font-semibold uppercase tracking-wider">{t}</span>
              </div>
              <div className="text-mute text-xs leading-relaxed">{d}</div>
            </div>
          ))}
        </div>
      </div>

      <footer className="text-xs text-faint mono pt-4 border-t border-edge leading-relaxed">
        Built by Scott Campbell &middot; FastAPI &middot; PostgreSQL &middot; Next.js &middot; Recharts.
        Bring-your-own-key (Claude / OpenAI / Gemini); the key never touches the server. Reads the same
        warehouse as the dashboard, read-only. Data is fully synthetic; no proprietary or employer data.
      </footer>
    </main>
  );
}
