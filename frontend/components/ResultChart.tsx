"use client";
// Shape-aware result rendering. The backend hints a viz type, but the right
// chart really depends on the columns/rows: a single-row metric wants KPI
// cards, a category+measure wants bars, a time series wants a line, a result
// with a low-cardinality category dimension wants one series per value (with a
// legend), and two measures on very different scales want a dual Y-axis. When a
// chart would distort or hide the data, we show a clean table instead.
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { RunResponse } from "@/lib/api";

type Row = Record<string, string | number | null>;

const AXIS = { fill: "#8896b4", fontSize: 12 };
const TIP = { background: "#0a0e1a", border: "1px solid #1f2a44", borderRadius: 8 };
const GRID = "#1f2a44";
// Accent first, then a colorblind-friendly spread for multi-series.
const PALETTE = ["#e0653f", "#5b9bd5", "#6fcf97", "#f2c94c", "#bb6bd9", "#56ccf2", "#eb5757", "#88d8b0"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ISO timestamps -> readable dates ("2024-06-01T00:00:00" -> "Jun 2024").
export function formatLabel(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return v;
  const [, y, mo, d, hh, mm] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const midnight = !hh || (hh === "00" && mm === "00");
  if (d === "01" && midnight) return `${month} ${y}`;
  if (midnight) return `${month} ${Number(d)}, ${y}`;
  return `${month} ${Number(d)}, ${y} ${hh}:${mm}`;
}

// "preventive_downtime_min" -> "Preventive Downtime Min"
export function humanizeKey(s: unknown): string {
  return String(s)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Measure values get thousands separators; never applied to the X axis, where a
// year like 2024 must not become "2,024".
export function formatValue(v: unknown): string {
  return typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v);
}

function formatCell(v: unknown): string {
  return typeof v === "number" ? formatValue(v) : formatLabel(v);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function isNumericCol(rows: Row[], c: string): boolean {
  let saw = false;
  for (const r of rows) {
    const v = r[c];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number") return false;
    saw = true;
  }
  return saw;
}

function isDateCol(rows: Row[], c: string): boolean {
  let saw = false;
  for (const r of rows) {
    const v = r[c];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
    saw = true;
  }
  return saw;
}

function distinctValues(rows: Row[], c: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const k = String(r[c]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// Collapse long-format rows (one row per axis×series) into wide format (one row
// per axis, a column per series value) so recharts can draw one line/bar each.
function pivot(rows: Row[], axisCol: string, seriesCol: string, measure: string): Row[] {
  const map = new Map<string, Row>();
  const order: string[] = [];
  for (const r of rows) {
    const k = String(r[axisCol]);
    if (!map.has(k)) {
      map.set(k, { [axisCol]: r[axisCol] });
      order.push(k);
    }
    map.get(k)![String(r[seriesCol])] = r[measure];
  }
  return order.map((k) => map.get(k)!);
}

function byDate(axisCol: string) {
  return (a: Row, b: Row) =>
    new Date(String(a[axisCol])).getTime() - new Date(String(b[axisCol])).getTime();
}

function Cards({ cols, row }: { cols: string[]; row: Row }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cols.map((c) => (
        <div key={c} className="kpi">
          <div className="kpi-value">{formatValue(row[c])}</div>
          <div className="kpi-label">{humanizeKey(c)}</div>
        </div>
      ))}
    </div>
  );
}

function Table({ cols, rows }: { cols: string[]; rows: Row[] }) {
  return (
    <div className="overflow-auto max-h-[440px]">
      <table className="data w-full">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left">
            {cols.map((c) => (
              <th key={c} className="py-1 pr-4">
                {humanizeKey(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="py-1.5 pr-4">
                  {formatCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const commonAxes = (axisCol: string, isTime: boolean, rightAxis: boolean) => (
  <>
    <CartesianGrid stroke={GRID} vertical={false} />
    <XAxis
      dataKey={axisCol}
      tick={AXIS}
      tickFormatter={formatLabel}
      {...(isTime ? {} : { angle: -20, textAnchor: "end" as const, interval: 0 })}
    />
    <YAxis yAxisId="left" tick={AXIS} tickFormatter={formatValue} />
    {rightAxis && (
      <YAxis yAxisId="right" orientation="right" tick={AXIS} tickFormatter={formatValue} />
    )}
    <Tooltip
      contentStyle={TIP}
      labelFormatter={formatLabel}
      formatter={(value, name) => [formatValue(value), humanizeKey(name)]}
    />
    <Legend formatter={humanizeKey} wrapperStyle={{ fontSize: 12 }} />
  </>
);

export function ResultChart({ res }: { res: RunResponse }) {
  const cols = res.columns ?? [];
  const rows = res.rows ?? [];

  if (rows.length === 0 || cols.length === 0) {
    return <div className="text-sm text-mute">The query returned no matching records.</div>;
  }

  // Single row of metrics → KPI cards.
  if (rows.length === 1) {
    return <Cards cols={cols} row={rows[0]} />;
  }

  const numericCols = cols.filter((c) => isNumericCol(rows, c));
  const dateCols = cols.filter((c) => isDateCol(rows, c));
  const categoricalCols = cols.filter((c) => !numericCols.includes(c));

  // Nothing to plot, or shape we can't chart honestly → table.
  if (numericCols.length === 0) return <Table cols={cols} rows={rows} />;

  const axisCol = dateCols[0] ?? categoricalCols[0] ?? cols[0];
  const isTime = dateCols.includes(axisCol);

  // A low-cardinality category (other than the axis) becomes the series split.
  const seriesCol = categoricalCols.find(
    (c) => c !== axisCol && distinctValues(rows, c).length >= 2 && distinctValues(rows, c).length <= 8,
  );

  const measures = numericCols;
  const height = 340;

  // Case A — long format with a series dimension and one measure:
  // pivot to one line/bar per series value.
  if (seriesCol && measures.length === 1) {
    const seriesKeys = distinctValues(rows, seriesCol);
    if (seriesKeys.length <= 8) {
      let data = pivot(rows, axisCol, seriesCol, measures[0]);
      if (isTime) data = [...data].sort(byDate(axisCol));
      return (
        <ResponsiveContainer width="100%" height={height}>
          {isTime ? (
            <LineChart data={data} margin={{ top: 8, right: 16, left: -6, bottom: 32 }}>
              {commonAxes(axisCol, isTime, false)}
              {seriesKeys.map((k, i) => (
                <Line
                  key={k}
                  yAxisId="left"
                  dataKey={k}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 8, right: 16, left: -6, bottom: 48 }}>
              {commonAxes(axisCol, isTime, false)}
              {seriesKeys.map((k, i) => (
                <Bar key={k} yAxisId="left" dataKey={k} fill={PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      );
    }
  }

  // Case B — wide format, one or more measures, no series split.
  // Each measure is its own line/bar; dual Y-axis when two measures sit on very
  // different scales (e.g. downtime hours vs. yield %).
  if (!seriesCol && measures.length >= 1) {
    const maxes = measures.map((m) => Math.max(...rows.map((r) => Number(r[m]) || 0), 0));
    const hi = Math.max(...maxes);
    const lo = Math.min(...maxes.filter((x) => x > 0), hi);
    const dual = measures.length === 2 && hi / Math.max(lo, 1) >= 20;
    const tooManyBars = !isTime && distinctValues(rows, axisCol).length > 30;

    if (!tooManyBars) {
      return (
        <ResponsiveContainer width="100%" height={height}>
          {isTime ? (
            <LineChart data={rows} margin={{ top: 8, right: 16, left: -6, bottom: 32 }}>
              {commonAxes(axisCol, isTime, dual)}
              {measures.map((m, i) => (
                <Line
                  key={m}
                  yAxisId={dual && i === 1 ? "right" : "left"}
                  dataKey={m}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={rows} margin={{ top: 8, right: 16, left: -6, bottom: 48 }}>
              {commonAxes(axisCol, isTime, dual)}
              {measures.map((m, i) => (
                <Bar
                  key={m}
                  yAxisId={dual && i === 1 ? "right" : "left"}
                  dataKey={m}
                  fill={PALETTE[i % PALETTE.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      );
    }
  }

  // Anything else (series dimension + multiple measures, very high cardinality,
  // etc.) is clearer as a table than a misleading chart.
  return <Table cols={cols} rows={rows} />;
}
