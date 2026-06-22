"use client";
// Shape-aware result rendering. The right chart depends on the columns/rows:
//   - one row of metrics            -> KPI cards
//   - category + one measure        -> bars
//   - time + one measure            -> line
//   - axis + a series dimension     -> one line/bar per series value (legend)
//   - axis + two off-scale measures -> dual Y-axis
//   - series dimension + 2+ measures-> small multiples (one mini dual-axis
//                                       chart per series value, shared scales)
//   - anything else                 -> a clean, formatted table
// Every chart shares one primitive (MeasureChart) so axes, tooltips, colors,
// and formatting stay identical across cases.
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

function byDate(axisCol: string) {
  return (a: Row, b: Row) =>
    new Date(String(a[axisCol])).getTime() - new Date(String(b[axisCol])).getTime();
}

// Collapse long-format rows into wide format: one row per axis value, a column
// per series value, so recharts can draw one line/bar each.
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

interface Scale {
  rightKey?: string;
  leftDomain: [number, number];
  rightDomain?: [number, number];
}

// Decide axis assignment for a set of measures. Two measures whose magnitudes
// differ by >=20x get split onto a dual axis; the right axis zooms to its own
// data range (so e.g. yield % isn't crushed against a 0 baseline).
function measureScale(rows: Row[], measures: string[]): Scale {
  const maxes = measures.map((m) => Math.max(...rows.map((r) => Number(r[m]) || 0), 0));
  const hi = Math.max(...maxes, 0);
  const lo = Math.min(...maxes.filter((x) => x > 0), hi);
  const dual = measures.length === 2 && hi / Math.max(lo, 1) >= 20;
  const rightKey = dual ? measures[1] : undefined;
  const leftKeys = measures.filter((m) => m !== rightKey);
  const leftMax = Math.max(...rows.flatMap((r) => leftKeys.map((m) => Number(r[m]) || 0)), 0);
  const leftDomain: [number, number] = [0, leftMax || 1];
  let rightDomain: [number, number] | undefined;
  if (rightKey) {
    const vals = rows
      .map((r) => Number(r[rightKey]))
      .filter((v) => !Number.isNaN(v));
    if (vals.length) rightDomain = [Math.min(...vals), Math.max(...vals)];
  }
  return { rightKey, leftDomain, rightDomain };
}

// The single chart primitive. `keys` are the dataKeys to draw (measure columns,
// or pivoted series values). Time axes draw lines; categorical axes draw bars.
function MeasureChart({
  data,
  axisCol,
  isTime,
  keys,
  rightKey,
  leftDomain,
  rightDomain,
  height,
  showLegend,
}: {
  data: Row[];
  axisCol: string;
  isTime: boolean;
  keys: string[];
  rightKey?: string;
  leftDomain?: [number, number];
  rightDomain?: [number, number];
  height: number;
  showLegend: boolean;
}) {
  const hasRight = Boolean(rightKey);
  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis
        dataKey={axisCol}
        tick={AXIS}
        tickFormatter={formatLabel}
        {...(isTime ? {} : { angle: -20, textAnchor: "end" as const, interval: 0 })}
      />
      <YAxis yAxisId="left" tick={AXIS} tickFormatter={formatValue} domain={leftDomain} />
      {hasRight && (
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={AXIS}
          tickFormatter={formatValue}
          domain={rightDomain}
        />
      )}
      <Tooltip
        contentStyle={TIP}
        labelFormatter={formatLabel}
        formatter={(value, name) => [formatValue(value), humanizeKey(name)]}
        // Default cursor is a bright grey block that fights the dark theme;
        // use a faint highlight (soft line for time, soft fill for bars).
        cursor={isTime ? { stroke: "#3b4a6b" } : { fill: "rgba(136,150,180,0.10)" }}
      />
      {showLegend && <Legend formatter={humanizeKey} wrapperStyle={{ fontSize: 12 }} />}
    </>
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      {isTime ? (
        <LineChart data={data} margin={{ top: 8, right: hasRight ? 8 : 16, left: -6, bottom: 24 }}>
          {axes}
          {keys.map((k, i) => (
            <Line
              key={k}
              yAxisId={k === rightKey ? "right" : "left"}
              dataKey={k}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls
            />
          ))}
        </LineChart>
      ) : (
        <BarChart data={data} margin={{ top: 8, right: hasRight ? 8 : 16, left: -6, bottom: 44 }}>
          {axes}
          {keys.map((k, i) => (
            <Bar
              key={k}
              yAxisId={k === rightKey ? "right" : "left"}
              dataKey={k}
              fill={PALETTE[i % PALETTE.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

// One shared legend chip row, used above small multiples so each facet stays
// uncluttered while colors map consistently across every panel.
function LegendChips({ keys }: { keys: string[] }) {
  // Inline styles (not Tailwind classes) so the swatches and spacing render
  // reliably regardless of the build's class generation.
  return (
    <div
      className="mb-3 text-xs text-mute"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 22px" }}
    >
      {keys.map((k, i) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center" }}>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: 9999,
              flexShrink: 0,
              marginRight: 8,
              background: PALETTE[i % PALETTE.length],
            }}
          />
          <span>{humanizeKey(k)}</span>
        </span>
      ))}
    </div>
  );
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

export function ResultChart({ res }: { res: RunResponse }) {
  const cols = res.columns ?? [];
  const rows = res.rows ?? [];

  if (rows.length === 0 || cols.length === 0) {
    return <div className="text-sm text-mute">The query returned no matching records.</div>;
  }

  // Single row of metrics → KPI cards.
  if (rows.length === 1) return <Cards cols={cols} row={rows[0]} />;

  const numericCols = cols.filter((c) => isNumericCol(rows, c));
  const dateCols = cols.filter((c) => isDateCol(rows, c));
  const categoricalCols = cols.filter((c) => !numericCols.includes(c));

  if (numericCols.length === 0) return <Table cols={cols} rows={rows} />;

  const axisCol = dateCols[0] ?? categoricalCols[0] ?? cols[0];
  const isTime = dateCols.includes(axisCol);
  const measures = numericCols;

  // A low-cardinality category is a series split ONLY in true long format (more
  // rows than distinct axis values). In wide format an extra category is a 1:1
  // label (e.g. fault_desc beside fault_code), not a dimension to split on.
  const distinctAxis = distinctValues(rows, axisCol).length;
  const longFormat = rows.length > distinctAxis;
  const seriesCol = longFormat
    ? categoricalCols.find(
        (c) =>
          c !== axisCol &&
          distinctValues(rows, c).length >= 2 &&
          distinctValues(rows, c).length <= 12 &&
          distinctValues(rows, c).length < distinctAxis,
      )
    : undefined;

  const tooManyBars = !isTime && distinctAxis > 30;

  // Case A — series dimension + one measure: one line/bar per series value.
  if (seriesCol && measures.length === 1 && !tooManyBars) {
    const seriesKeys = distinctValues(rows, seriesCol);
    if (seriesKeys.length <= 8) {
      let data = pivot(rows, axisCol, seriesCol, measures[0]);
      if (isTime) data = [...data].sort(byDate(axisCol));
      return (
        <MeasureChart
          data={data}
          axisCol={axisCol}
          isTime={isTime}
          keys={seriesKeys}
          height={340}
          showLegend
        />
      );
    }
  }

  // Case B — series dimension + 2+ measures: small multiples. One mini chart per
  // series value, all sharing the same axes/scales for honest comparison.
  if (seriesCol && measures.length >= 2 && !tooManyBars) {
    const seriesKeys = distinctValues(rows, seriesCol);
    if (seriesKeys.length <= 12) {
      const scale = measureScale(rows, measures); // shared across every facet
      return (
        <div>
          <LegendChips keys={measures} />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {seriesKeys.map((k) => {
              let data = rows.filter((r) => String(r[seriesCol]) === k);
              if (isTime) data = [...data].sort(byDate(axisCol));
              return (
                <div key={k} className="border border-edge rounded-lg p-3">
                  <div className="text-xs text-faint uppercase tracking-wider mb-2">
                    {humanizeKey(seriesCol)}: {formatLabel(k)}
                  </div>
                  <MeasureChart
                    data={data}
                    axisCol={axisCol}
                    isTime={isTime}
                    keys={measures}
                    rightKey={scale.rightKey}
                    leftDomain={scale.leftDomain}
                    rightDomain={scale.rightDomain}
                    height={200}
                    showLegend={false}
                  />
                </div>
              );
            })}
          </div>
        </div>
      );
    }
  }

  // Case C — wide format, one or more measures, no series split. A single chart
  // doesn't need a forced left domain (recharts picks rounder ticks on its own);
  // only the secondary axis is zoomed when it's a dual-axis chart.
  if (!seriesCol && measures.length >= 1 && !tooManyBars) {
    const scale = measureScale(rows, measures);
    const data = isTime ? [...rows].sort(byDate(axisCol)) : rows;
    return (
      <MeasureChart
        data={data}
        axisCol={axisCol}
        isTime={isTime}
        keys={measures}
        rightKey={scale.rightKey}
        rightDomain={scale.rightDomain}
        height={340}
        showLegend={measures.length > 1}
      />
    );
  }

  // Very high cardinality or other awkward shapes read better as a table.
  return <Table cols={cols} rows={rows} />;
}
