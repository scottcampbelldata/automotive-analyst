"use client";
import { useEffect, useRef, useState } from "react";
import { api, RunResponse } from "@/lib/api";
import { planQuery, repairSQL, summarizeResult, QueryPlan, SchemaContext } from "@/lib/providers";
import { Creds, PROVIDERS, clearCreds, loadCreds } from "@/lib/keyStore";
import { KeyPanel } from "@/components/KeyPanel";
import { ResultChart } from "@/components/ResultChart";
import { ReportBand, CASE_STUDY, REPO } from "@/components/ReportBand";
import { SiteBar, ConsultFooter } from "@/components/SiteFrame";

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
  repairing: "The query failed, so the model is fixing it...",
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
  // A ref, not state: it has to be readable synchronously inside run(), before
  // React has re-rendered with the new phase.
  const runningRef = useRef(false);

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
    // Re-entrancy guard. The button is disabled while loading, but the input's
    // Enter handler is not gated by React state, so holding Enter (key
    // auto-repeat) fired a burst of concurrent runs - each one billing the
    // visitor's own provider key, and each racing the others' state updates so a
    // slow earlier answer could overwrite a newer one.
    if (runningRef.current) return;
    if (!question.trim()) return;
    if (!creds) {
      setEditingKey(true);
      return;
    }
    runningRef.current = true;
    let context = ctx;
    if (!context) {
      try {
        context = await api.context();
        setCtx(context);
      } catch {
        setErr("Could not load the schema context from the API. Is the backend reachable?");
        runningRef.current = false; // this return is outside the try/finally below
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
      runningRef.current = false;
    }
  }

  return (
    <>
    <SiteBar caseStudy={CASE_STUDY} repo={REPO} />
    <ReportBand />
    <main className="max-w-[1120px] mx-auto px-5 sm:px-6 pt-8 space-y-7">
      {/* Key status / management */}
      {creds && !editingKey && (
        <div className="flex items-center justify-between flex-wrap gap-2 text-[0.95rem]">
          <span className="text-mute">
            Provider <span className="text-strong">{providerLabel}</span>, model{" "}
            <span className="mono text-strong text-[0.85rem]">{creds.model}</span>.{" "}
            <span className="text-good">The key is held in this tab only.</span>
          </span>
          <span className="flex gap-4">
            <button onClick={() => setEditingKey(true)} className="btn-link">
              Change key
            </button>
            <button
              onClick={() => { clearCreds(); setCreds(null); }}
              className="btn-link"
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
      <section className="card space-y-4" aria-labelledby="ask-title">
        <h2 id="ask-title" className="section-title">Ask the warehouse</h2>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run(q)}
            placeholder="e.g. which station lost the most hours on D-crew last quarter?"
            aria-label="Question"
            className="field flex-1"
          />
          <button
            onClick={() => run(q)}
            disabled={loading}
            className="btn-primary px-5 whitespace-nowrap"
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

        {/* Andon rail: lights up as the pipeline runs */}
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
          {loading && <div className="text-sm text-mute italic mt-2">{PHASE_LABEL[phase]}</div>}
        </div>
      </section>

      {err && (
        <div className="card">
          <div className="text-bad font-semibold mb-1">Couldn&apos;t complete the request</div>
          <p className="text-sm text-mute">{err}</p>
        </div>
      )}

      {notEnoughData && (
        <div className="card">
          <div className="text-warn font-semibold mb-1">Not enough data in this warehouse</div>
          <p className="text-sm text-mute">{notEnoughData}</p>
        </div>
      )}

      {(res || genSql) && (
        <div className="card space-y-4">
          {res &&
            (res.ok ? (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="section-title">Answer</h2>
                  <span className="flex gap-2">
                    {repaired && (
                      <span className="badge" style={{ color: "var(--warn)" }}>
                        <span className="lamp amber" style={{ boxShadow: "none" }} /> Self-corrected
                      </span>
                    )}
                    <span className="badge" style={{ color: "var(--good)" }}>
                      <span className="lamp green" style={{ boxShadow: "none" }} /> Guardrail: {res.guardrail}
                    </span>
                  </span>
                </div>
                {answer && <p className="text-[1.05rem] text-ink leading-relaxed max-w-3xl">{answer}</p>}
                <ResultChart res={res} />
                <div className="text-sm text-mute">{res.row_count} row(s) returned</div>
              </>
            ) : (
              <div>
                <div className="text-bad font-semibold mb-1">
                  {res.stage === "guardrail"
                    ? "Query blocked by guardrails"
                    : `Could not answer (${res.stage})`}
                </div>
                <p className="text-sm text-mute">{res.error}</p>
              </div>
            ))}

          {genSql && (
            <div>
              <div className="eyebrow mb-2">
                Generated SQL{providerLabel ? ` (${providerLabel})` : ""}
              </div>
              {plan?.reason && res?.ok && (
                <div className="text-sm text-mute mb-2">{plan.reason}</div>
              )}
              <pre className="sql">{genSql}</pre>
            </div>
          )}
        </div>
      )}

      {/* How it works: the four-step sequence */}
      <section className="card" aria-labelledby="how-title">
        <h2 id="how-title" className="section-title mb-4">How a question becomes an answer</h2>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-5">
          {[
            ["01", "Your key", "Your provider key stays in this browser tab and calls Claude, OpenAI or Gemini directly, never our server."],
            ["02", "Generate", "Your model writes one PostgreSQL SELECT, grounded in the star schema served by the API."],
            ["03", "Guardrail", "The server validates it: SELECT-only, single statement, allow-listed tables, LIMIT injected."],
            ["04", "Execute", "Run as a read-only role inside a read-only transaction with a statement timeout. Self-corrects once on error."],
          ].map(([n, t, d]) => (
            <li key={n} className="border-t border-edge pt-3">
              <div className="flex items-baseline gap-2 mb-1">
                <span className="mono text-accent text-[0.85rem]">{n}</span>
                <span className="text-strong font-semibold">{t}</span>
              </div>
              <div className="text-mute text-[0.95rem] leading-relaxed">{d}</div>
            </li>
          ))}
        </ol>
      </section>

      <p className="text-sm text-mute pt-5 border-t border-edge leading-relaxed">
        Stack: FastAPI, PostgreSQL, Next.js and Recharts.
      </p>
    </main>
    <ConsultFooter caseStudy={CASE_STUDY} />
    </>
  );
}
