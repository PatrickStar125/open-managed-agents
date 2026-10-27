import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useApiQuery } from "../lib/useApiQuery";
import { formatCompact, isoAdd, isoDiff, isoToday } from "../lib/format";
import { useI18n } from "../i18n";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { RANGE_PRESETS, UsageRangeControls } from "../components/UsageRangeControls";

/**
 * Workspace usage page — the "what did it cost" view the docs promise on
 * the Dashboard but that no OSS page has shipped yet.
 *
 * Data source: `GET /v1/oma/usage?from&to` (inclusive YYYY-MM-DD), a
 * read-only rollup over the usage facts the platform already records:
 *   - token counters mirror the four `model_usage` fields every
 *     `span.model_request_end` event carries (input / output /
 *     cachedRead / cachedWrite),
 *   - sandbox minutes mirror the D1 ledger entries billed per session.
 * The page fetches one extra window before `from` so the cards can show
 * a delta against the previous equal period without a second request.
 *
 * Framing follows the platform's cost-attribution doctrine: token usage
 * is BYOK observation (your provider bills it), sandbox minutes are the
 * only platform-metered line. The sandbox estimate is display-only.
 *
 * Visual system (modeled on the modern usage-report pages — hero/​detail
 * card hierarchy, single-metric gradient area chart switched by tabs,
 * compact date-range controls — realized in the project's own tokens):
 * a tinted report canvas (bg-bg-surface) with floating Cards
 * (rounded-xl + shadow-card-soft) in a single-hue brand family. The
 * chart draws one selected metric at a time as a smooth gradient area;
 * tabs carry the metric identity, so no multi-series legend is needed.
 * Until the backend endpoint lands, `src/mocks/usage.ts` serves a
 * deterministic demo dataset — run the console with `?mocks=1`.
 */

// Chart palette: light uses the brand token verbatim; dark snaps one
// step down into the chart lightness band.
const CHART_CSS = `
.usage-chart {
  --chart-accent: var(--brand);
}
.dark .usage-chart {
  --chart-accent: #e45934;
}
`;

// ────────────────────────────────────────────────────────────────────────
// Wire types. Named after the platform's own metric vocabulary so the
// eventual server implementation maps 1:1.
// ────────────────────────────────────────────────────────────────────────

interface UsageDay {
  /** YYYY-MM-DD, UTC */
  date: string;
  sessions: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
  sandbox_minutes: number;
}

interface UsageByModel {
  model_id: string;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
}

interface UsageByAgent {
  agent_id: string;
  agent_name: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  sandbox_minutes: number;
}

interface UsageBySandbox {
  runtime_id: string;
  name: string;
  sessions: number;
  sandbox_minutes: number;
}

interface UsageResponse {
  range: { from: string; to: string; days: number };
  totals: Omit<UsageDay, "date">;
  daily: UsageDay[];
  by_model: UsageByModel[];
  by_agent: UsageByAgent[];
  by_sandbox: UsageBySandbox[];
}

/** Hosted cloud-sandbox rate. Display-only — see header comment. */
const SANDBOX_RATE_USD_PER_MIN = 0.005;

const MAX_SPAN_DAYS = 90;

type MetricKey =
  | "input_tokens"
  | "output_tokens"
  | "cached_read_tokens"
  | "model_calls"
  | "sandbox_minutes";

const mmdd = (iso: string) => iso.slice(5).replace("-", "/");

// ────────────────────────────────────────────────────────────────────────
// Formatting. Card values show full grouped digits (the report-page
// convention); `formatCompact` (lib/format) is for axis ticks and table
// cells. `tabular-nums` is reserved for columns and ticks that align.
// ────────────────────────────────────────────────────────────────────────

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed percent, `–` when the comparison base is zero. */
function deltaPct(cur: number, prev: number): string {
  if (prev === 0) return "–";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%`;
}

// ────────────────────────────────────────────────────────────────────────
// Monotone-cubic smooth path (Fritsch–Carlson) — smooth SaaS-chart
// curves without the overshoot a plain Catmull-Rom produces at sharp
// day-to-day steps.
// ────────────────────────────────────────────────────────────────────────

function monotonePath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dxI = pts[i + 1][0] - pts[i][0];
    dx.push(dxI);
    slope.push((pts[i + 1][1] - pts[i][1]) / (dxI || 1));
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  m.push(slope[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + m[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/** Round a peak up to a 1 / 2 / 2.5 / 5 × 10^k step for clean ticks. */
function niceCeil(v: number): number {
  const exp = Math.floor(Math.log10(Math.max(v, 1)));
  const base = Math.pow(10, exp);
  for (const mul of [1, 2, 2.5, 5, 10]) {
    if (v <= mul * base) return mul * base;
  }
  return 10 * base;
}

// ────────────────────────────────────────────────────────────────────────
// Sparkline — 12-point trend of the card's own daily metric in the
// de-emphasis hue, current period dotted in the accent. Same daily
// rollup the chart reads; no extra request.
// ────────────────────────────────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 100;
  const H = 30;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts: Array<[number, number]> = values.map((v, i) => [
    (i * W) / (values.length - 1),
    H - 3 - ((v - min) / span) * (H - 6),
  ]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[30px]" aria-hidden="true">
      <path
        d={monotonePath(pts)}
        fill="none"
        stroke="var(--fg-subtle)"
        strokeOpacity={0.55}
        strokeWidth={2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={pts[pts.length - 1][0]}
        cy={pts[pts.length - 1][1]}
        r={2.5}
        fill="var(--chart-accent)"
      />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Usage trend chart — one selected metric as a smooth gradient area.
// Tabs on the card header carry the metric identity, so the chart draws
// a single series and needs no legend. Marks: 2px line, gradient wash
// (~20%→0), end-dot with a 2px surface ring, solid hairline grid,
// compact y ticks, one direct label on the peak. Interaction: crosshair
// hover + HTML tooltip; drag horizontally to brush-zoom, double-click
// or the chip to reset.
// ────────────────────────────────────────────────────────────────────────

interface ChartLabels {
  metricName: string;
  chartTitle: string;
  sessions: string;
  resetZoom: string;
}

function MetricChart({
  daily,
  metric,
  labels,
}: {
  daily: UsageDay[];
  metric: MetricKey;
  labels: ChartLabels;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Zoom is a [start, end] index pair into `daily`; null = full range.
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const base0 = zoom ? zoom[0] : 0;
  const visible = zoom ? daily.slice(zoom[0], zoom[1] + 1) : daily;

  const W = 780;
  const H = 300;
  const PAD_L = 46;
  const PAD_R = 12;
  const PAD_T = 24;
  const PAD_B = 28;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const slot = plotW / Math.max(visible.length, 1);
  const xAt = (i: number) => PAD_L + slot * (i + 0.5);

  const peakVal = Math.max(...visible.map((d) => d[metric]), 1);
  const yMax = niceCeil(peakVal * 1.05);
  const y = (v: number) => PAD_T + plotH * (1 - v / yMax);
  const peakIdx = visible.reduce(
    (best, d, i) => (d[metric] > visible[best][metric] ? i : best),
    0,
  );

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const labelEvery = Math.ceil(visible.length / 10);

  const pts: Array<[number, number]> = visible.map((d, i) => [
    xAt(i),
    y(d[metric]),
  ]);
  const line = monotonePath(pts);
  const baseY = PAD_T + plotH;
  const area = pts.length
    ? `${line} L${pts[pts.length - 1][0].toFixed(1)},${baseY} L${pts[0][0].toFixed(1)},${baseY} Z`
    : "";

  const hovered = hover !== null ? visible[hover] : null;
  const hoverFrac = hover !== null ? xAt(hover) / W : 0.5;

  // ── Pointer plumbing: client → viewBox x, shared by hover + brush ────
  const toViewX = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return ((clientX - r.left) / r.width) * W;
  };
  const idxFromX = (vx: number) => {
    const i = Math.round((vx - PAD_L) / slot - 0.5);
    return Math.min(Math.max(i, 0), visible.length - 1);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const vx = toViewX(e.clientX);
    if (vx < PAD_L - 4 || vx > W - PAD_R + 4) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x0: vx, x1: vx });
    setHover(null);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const vx = toViewX(e.clientX);
    if (drag) {
      setDrag((d) => (d ? { ...d, x1: vx } : d));
    } else if (vx >= PAD_L - 4 && vx <= W - PAD_R + 4) {
      setHover(idxFromX(vx));
    }
  };
  const onPointerUp = () => {
    if (!drag) return;
    const lo = Math.min(drag.x0, drag.x1);
    const hi = Math.max(drag.x0, drag.x1);
    setDrag(null);
    if (hi - lo < slot * 1.5) return; // a click, not a brush
    const i0 = base0 + idxFromX(lo);
    const i1 = base0 + idxFromX(hi);
    if (i1 > i0) setZoom([i0, i1]);
  };

  return (
    <div className="relative">
      {zoom && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setZoom(null)}
          className="absolute top-1 left-1 z-10 rounded-full border border-border bg-bg px-2.5 text-fg-muted shadow-card-soft"
        >
          <span className="font-medium text-fg">
            {mmdd(daily[zoom[0]].date)} – {mmdd(daily[zoom[1]].date)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{labels.resetZoom} ✕</span>
        </Button>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full touch-none ${drag ? "cursor-grabbing" : "cursor-crosshair"} select-none`}
        role="img"
        aria-label={labels.chartTitle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setHover(null);
          setDrag(null);
        }}
        onPointerLeave={() => {
          setHover(null);
          setDrag(null);
        }}
        onDoubleClick={() => setZoom(null)}
      >
        <defs>
          <linearGradient id="usage-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--chart-accent)", stopOpacity: 0.2 }} />
            <stop offset="100%" style={{ stopColor: "var(--chart-accent)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        {/* Gridlines + compact y ticks — recessive, solid hairlines. */}
        {ticks.map((tv, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(tv)}
              y2={y(tv)}
              stroke="var(--border)"
              strokeWidth={1}
              pointerEvents="none"
            />
            <text
              x={PAD_L - 8}
              y={y(tv) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--fg-subtle)"
              style={{ fontVariantNumeric: "tabular-nums" }}
              pointerEvents="none"
            >
              {formatCompact(tv)}
            </text>
          </g>
        ))}

        <path d={area} fill="url(#usage-grad)" pointerEvents="none" />
        <path
          d={line}
          fill="none"
          stroke="var(--chart-accent)"
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />

        {/* End-dot with a 2px surface ring. */}
        {visible.length > 0 && (
          <circle
            cx={pts[pts.length - 1][0]}
            cy={pts[pts.length - 1][1]}
            r={3.5}
            fill="var(--chart-accent)"
            stroke="var(--bg)"
            strokeWidth={2}
            pointerEvents="none"
          />
        )}

        {/* One direct label: the peak. */}
        <text
          x={pts[peakIdx][0]}
          y={pts[peakIdx][1] - 10}
          textAnchor="middle"
          fontSize={10}
          fill="var(--fg-muted)"
          style={{ fontVariantNumeric: "tabular-nums" }}
          pointerEvents="none"
        >
          {formatCompact(visible[peakIdx][metric])}
        </text>

        {/* Crosshair + dot on hover. */}
        {hover !== null && !drag && (
          <g pointerEvents="none">
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={PAD_T}
              y2={baseY}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <circle
              cx={pts[hover][0]}
              cy={pts[hover][1]}
              r={4}
              fill="var(--chart-accent)"
              stroke="var(--bg)"
              strokeWidth={2}
            />
          </g>
        )}

        {/* X labels. */}
        {visible.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={d.date}
              x={xAt(i)}
              y={H - 9}
              textAnchor="middle"
              fontSize={10}
              fill="var(--fg-subtle)"
              pointerEvents="none"
            >
              {mmdd(d.date)}
            </text>
          ) : null,
        )}

        {/* Brush rubber band. */}
        {drag && Math.abs(drag.x1 - drag.x0) > 2 && (
          <rect
            x={Math.min(drag.x0, drag.x1)}
            y={PAD_T}
            width={Math.abs(drag.x1 - drag.x0)}
            height={plotH}
            fill="var(--chart-accent)"
            fillOpacity={0.08}
            stroke="var(--chart-accent)"
            strokeOpacity={0.35}
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Tooltip — title line, the metric value, then context rows in
          muted ink. Hidden while brushing. */}
      {hovered && !drag && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-md border border-border bg-bg shadow-card-soft px-3 py-2.5 text-xs"
          style={{
            left: `${hoverFrac * 100}%`,
            transform:
              hoverFrac < 0.2
                ? "translateX(0)"
                : hoverFrac > 0.8
                  ? "translateX(-100%)"
                  : "translateX(-50%)",
          }}
        >
          <div className="font-medium text-fg mb-1.5">{hovered.date}</div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-6">
              <span className="inline-flex items-center gap-1.5 text-fg-muted">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ background: "var(--chart-accent)" }}
                />
                {labels.metricName}
              </span>
              <span
                className="text-right text-fg font-medium"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {hovered[metric].toLocaleString()}
              </span>
            </div>
            <TooltipRow label={labels.sessions} value={String(hovered.sessions)} muted />
          </div>
        </div>
      )}
    </div>
  );
}

function TooltipRow({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className={muted ? "text-fg-subtle" : "text-fg-muted"}>{label}</span>
      <span
        className={`text-right ${muted ? "text-fg-muted" : "text-fg font-medium"}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cards — hero row (full grouped digits + unit, no sparkline) over a
// detail row (compact value + delta + sparkline), both in the project
// Card (rounded-xl + soft shadow).
// ────────────────────────────────────────────────────────────────────────

function HeroCard({
  label,
  value,
  unit,
  delta,
}: {
  label: string;
  value: string;
  unit?: string;
  delta: string;
}) {
  return (
    <Card className="usage-chart gap-3 px-6 py-5 rounded-xl">
      <div className="flex items-baseline gap-2">
        <div className="font-display text-[30px] leading-none font-semibold text-fg">
          {value}
        </div>
        {unit && (
          <div className="text-sm text-fg-subtle font-medium">{unit}</div>
        )}
        <div className="ml-auto text-[11px] text-fg-subtle whitespace-nowrap">
          {delta}
        </div>
      </div>
      <div className="text-[13px] text-fg-muted">{label}</div>
    </Card>
  );
}

function DetailCard({
  label,
  value,
  unit,
  delta,
  vsPrev,
  spark,
}: {
  label: string;
  value: string;
  unit?: string;
  delta: string;
  vsPrev: string;
  spark: number[];
}) {
  return (
    <Card className="usage-chart gap-3 px-6 py-5 rounded-xl">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <div className="font-display text-[22px] leading-none font-semibold text-fg">
            {value}
          </div>
          {unit && (
            <div className="text-xs text-fg-subtle font-medium">{unit}</div>
          )}
        </div>
        <div className="text-[11px] text-fg-subtle whitespace-nowrap">
          {delta}
        </div>
      </div>
      <div className="text-[13px] text-fg-muted">{label}</div>
      <Sparkline values={spark} />
      <div className="text-[10px] text-fg-subtle">{vsPrev}</div>
    </Card>
  );
}

/** Breakdown card — dynamic list rows with a full-width share meter per
 * row. Replaces the old table+meter-column layout: a fixed-width meter
 * cell rendered invisible slivers for small shares and broke at narrow
 * card widths; a row-spanning meter keeps any non-zero share legible
 * and lets the card reflow freely. */
interface BreakdownRowData {
  id: string;
  label: string;
  /** Small secondary line under the label (e.g. "1,712 calls"). */
  sub?: string;
  /** Headline value, right-aligned. */
  value: string;
  /** Unit suffix for the value — dimensions differ (tokens vs min). */
  unit?: string;
  /** Share of the dimension total, 0..1, drives the meter. */
  share: number;
  mono?: boolean;
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: BreakdownRowData[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {rows.map((r) => {
          const pct = Math.round(r.share * 100);
          return (
            <div
              key={r.id}
              className="px-6 py-2.5 border-t border-border first:border-t-0 hover:bg-bg-surface/40 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div
                    className={`truncate text-sm ${r.mono ? "text-fg-muted font-mono text-[12px]" : "text-fg"}`}
                  >
                    {r.label}
                  </div>
                  {r.sub && (
                    <div className="mt-0.5 text-[11px] text-fg-subtle">{r.sub}</div>
                  )}
                </div>
                <div className="flex items-baseline gap-1 whitespace-nowrap">
                  <span
                    className="text-sm text-fg-muted"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {r.value}
                  </span>
                  {r.unit && (
                    <span className="text-[11px] text-fg-subtle">{r.unit}</span>
                  )}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <div className="h-1.5 flex-1 min-w-8 rounded-full bg-bg-surface overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--chart-accent)]"
                    style={{
                      width: `${Math.min(Math.max(r.share * 100, 0), 100)}%`,
                      // Keep a visible sliver for any non-zero share.
                      minWidth: r.share > 0 ? 6 : 0,
                    }}
                  />
                </div>
                <span
                  className="w-9 text-right text-[11px] text-fg-subtle"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {pct}%
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Page — a tinted report canvas with floating cards.
// ────────────────────────────────────────────────────────────────────────

export function Usage() {
  const { t } = useI18n();
  const [from, setFrom] = useState(() => isoAdd(isoToday(), -13));
  const [to, setTo] = useState(() => isoToday());
  const [metric, setMetric] = useState<MetricKey>("input_tokens");

  const span = Math.min(isoDiff(from, to) + 1, MAX_SPAN_DAYS);
  const activePreset =
    span <= 30 && isoAdd(from, span - 1) >= isoToday()
      ? (RANGE_PRESETS.find((p) => p === span) ?? null)
      : null;

  // One request covering [from - span, to]; the extra head window is the
  // "previous period" the card deltas compare against.
  const { data: full, isLoading, error } = useApiQuery<UsageResponse>(
    "/v1/oma/usage",
    { from: isoAdd(from, -span), to },
  );

  const data = useMemo(() => {
    if (!full) return null;
    const daily = full.daily
      .filter((d) => d.date >= from && d.date <= to)
      .slice(0, MAX_SPAN_DAYS);
    const prevDaily = full.daily.filter((d) => d.date < from);
    const sum = (rows: UsageDay[], k: keyof UsageDay) =>
      rows.reduce((acc, r) => acc + (r[k] as number), 0);
    const pick = (rows: UsageDay[]): UsageResponse["totals"] => ({
      sessions: sum(rows, "sessions"),
      model_calls: sum(rows, "model_calls"),
      input_tokens: sum(rows, "input_tokens"),
      output_tokens: sum(rows, "output_tokens"),
      cached_read_tokens: sum(rows, "cached_read_tokens"),
      sandbox_minutes: sum(rows, "sandbox_minutes"),
    });
    // Breakdowns cover the FULL requested window (display + prev-period
    // head); rescale by the length ratio to approximate the display
    // window. Exact against even activity, approximate when the two
    // halves are lopsided — exact scoping needs a second request.
    const f = full.daily.length / Math.max(daily.length, 1);
    const scale = (v: number) => Math.round(v / f);
    return {
      totals: pick(daily),
      prev: pick(prevDaily),
      daily,
      by_model: full.by_model.map((m) => ({
        ...m,
        model_calls: scale(m.model_calls),
        input_tokens: scale(m.input_tokens),
        output_tokens: scale(m.output_tokens),
        cached_read_tokens: scale(m.cached_read_tokens),
      })),
      by_agent: full.by_agent.map((a) => ({
        ...a,
        sessions: scale(a.sessions),
        input_tokens: scale(a.input_tokens),
        output_tokens: scale(a.output_tokens),
        sandbox_minutes: scale(a.sandbox_minutes),
      })),
      by_sandbox: (full.by_sandbox ?? []).map((s) => ({
        ...s,
        sessions: scale(s.sessions),
        sandbox_minutes: scale(s.sandbox_minutes),
      })),
    };
  }, [full, from, to]);

  const setPreset = (days: number) => {
    setFrom(isoAdd(isoToday(), -(days - 1)));
    setTo(isoToday());
  };
  const setCustomFrom = (v: string) => {
    if (!v) return;
    setFrom(v);
    if (v > to) setTo(v);
    else if (isoDiff(v, to) >= MAX_SPAN_DAYS)
      setTo(isoAdd(v, MAX_SPAN_DAYS - 1));
  };
  const setCustomTo = (v: string) => {
    if (!v) return;
    setTo(v);
    if (v < from) setFrom(v);
    else if (isoDiff(from, v) >= MAX_SPAN_DAYS)
      setFrom(isoAdd(v, -(MAX_SPAN_DAYS - 1)));
  };

  // 12-point sparkline sample of a daily metric.
  const spark = (k: keyof UsageDay): number[] => {
    const d = data?.daily ?? [];
    if (d.length <= 12) return d.map((r) => r[k] as number);
    const step = (d.length - 1) / 11;
    return Array.from(
      { length: 12 },
      (_, i) => d[Math.round(i * step)][k] as number,
    );
  };

  const totals = data?.totals;
  const prev = data?.prev;
  const vsPrev = `${t.usage.vsPrevPrefix}${span}${t.usage.vsPrevSuffix}`;
  const estCost = totals
    ? totals.sandbox_minutes * SANDBOX_RATE_USD_PER_MIN
    : null;

  const METRIC_TABS: Array<{ key: MetricKey; label: string }> = [
    { key: "input_tokens", label: t.usage.legendInput },
    { key: "output_tokens", label: t.usage.legendOutput },
    { key: "cached_read_tokens", label: t.usage.cachedRead },
    { key: "model_calls", label: t.usage.modelCalls },
    { key: "sandbox_minutes", label: t.usage.sandboxMinutes },
  ];
  const metricName =
    METRIC_TABS.find((m) => m.key === metric)?.label ?? "—";

  const modelTotalInput =
    data?.by_model.reduce((a, m) => a + m.input_tokens, 0) ?? 1;
  const agentTotalTokens =
    data?.by_agent.reduce((a, x) => a + x.input_tokens, 0) ?? 1;
  const sandboxTotalMinutes =
    data?.by_sandbox.reduce((a, x) => a + x.sandbox_minutes, 0) ?? 1;

  return (
    <div className="flex-1 overflow-y-auto bg-bg-surface">
      <style>{CHART_CSS}</style>
      <div className="usage-chart mx-auto w-full max-w-[1400px] px-6 lg:px-8 py-8 space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
              {t.usage.title}
            </h1>
          </div>
          {estCost !== null && (
            <p className="text-[13px] text-fg-muted">
              {t.usage.sandboxMinutes} ·{" "}
              <span className="font-medium text-fg">
                {totals?.sandbox_minutes.toLocaleString()} min
              </span>
              <span className="text-fg-subtle">
                {" "}
                — {t.usage.estPrefix}
                {usd(estCost)}
                {t.usage.estSuffix}
              </span>
            </p>
          )}
        </header>

        {error ? (
          <EmptyState title={t.usage.loadFailed} body={String(error)} />
        ) : isLoading || !data ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="gap-3 px-6 py-5">
                  <Skeleton className="h-7 w-32" rounded="sm" />
                  <Skeleton className="h-4 w-20" rounded="sm" />
                </Card>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="gap-3 px-6 py-5">
                  <Skeleton className="h-6 w-24" rounded="sm" />
                  <Skeleton className="h-4 w-20" rounded="sm" />
                  <Skeleton className="h-[30px] w-full" rounded="sm" />
                </Card>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Hero row — full grouped digits. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <HeroCard
                label={t.usage.totalTokens}
                value={(data.totals.input_tokens + data.totals.output_tokens).toLocaleString()}
                unit={t.usage.tokensUnit}
                delta={deltaPct(
                  data.totals.input_tokens + data.totals.output_tokens,
                  (data.prev?.input_tokens ?? 0) + (data.prev?.output_tokens ?? 0),
                )}
              />
              <HeroCard
                label={t.usage.modelCalls}
                value={data.totals.model_calls.toLocaleString()}
                unit={t.usage.callsUnit}
                delta={deltaPct(data.totals.model_calls, data.prev?.model_calls ?? 0)}
              />
              <HeroCard
                label={t.usage.sandboxMinutes}
                value={data.totals.sandbox_minutes.toLocaleString()}
                unit={t.usage.minutesUnit}
                delta={deltaPct(data.totals.sandbox_minutes, data.prev?.sandbox_minutes ?? 0)}
              />
            </div>

            {/* Detail row — compact + trend. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <DetailCard
                label={t.usage.inputTokens}
                value={formatCompact(data.totals.input_tokens)}
                unit={t.usage.tokensUnit}
                delta={deltaPct(data.totals.input_tokens, data.prev?.input_tokens ?? 0)}
                vsPrev={vsPrev}
                spark={spark("input_tokens")}
              />
              <DetailCard
                label={t.usage.outputTokens}
                value={formatCompact(data.totals.output_tokens)}
                unit={t.usage.tokensUnit}
                delta={deltaPct(data.totals.output_tokens, data.prev?.output_tokens ?? 0)}
                vsPrev={vsPrev}
                spark={spark("output_tokens")}
              />
              <DetailCard
                label={t.usage.cachedRead}
                value={formatCompact(data.totals.cached_read_tokens)}
                unit={t.usage.tokensUnit}
                delta={deltaPct(data.totals.cached_read_tokens, data.prev?.cached_read_tokens ?? 0)}
                vsPrev={vsPrev}
                spark={spark("cached_read_tokens")}
              />
            </div>
          </>
        )}

        {/* Trend chart — card header carries metric tabs + range. */}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 sm:gap-1.5">
            <CardTitle className="text-[15px]">{t.usage.dailyTitle}</CardTitle>
            <UsageRangeControls
              from={from}
              to={to}
              maxTo={isoToday()}
              activePreset={activePreset}
              onPreset={setPreset}
              onFrom={setCustomFrom}
              onTo={setCustomTo}
            />
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-[280px] w-full" rounded="md" />
            ) : data.daily.length === 0 ||
              data.daily.every((d) => d[metric] === 0) ? (
              <EmptyState title={t.usage.emptyTitle} body={t.usage.emptyBody} />
            ) : (
              <MetricChart
                key={`${metric}:${from}:${to}`}
                daily={data.daily}
                metric={metric}
                labels={{
                  metricName,
                  chartTitle: t.usage.dailyTitle,
                  sessions: t.usage.sessions,
                  resetZoom: t.usage.resetZoom,
                }}
              />
            )}
          </CardContent>
        </Card>

        {/* Breakdown cards — dynamic rows, full-width share meters. */}
        {data &&
          (data.by_model.length > 0 ||
            data.by_agent.length > 0 ||
            data.by_sandbox.length > 0) && (
          <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
            <BreakdownCard
              title={t.usage.byModel}
              rows={data.by_model.map((m) => ({
                id: m.model_id,
                label: m.model_id,
                mono: true,
                sub: `${m.model_calls.toLocaleString()} ${t.usage.callsUnit}`,
                value: formatCompact(m.input_tokens),
                unit: t.usage.tokensUnit,
                share: m.input_tokens / modelTotalInput,
              }))}
            />
            <BreakdownCard
              title={t.usage.byAgent}
              rows={data.by_agent.map((a) => ({
                id: a.agent_id,
                label: a.agent_name,
                sub: `${a.sessions.toLocaleString()} ${t.usage.sessions}`,
                value: formatCompact(a.input_tokens),
                unit: t.usage.tokensUnit,
                share: a.input_tokens / agentTotalTokens,
              }))}
            />
            <BreakdownCard
              title={t.usage.bySandbox}
              rows={data.by_sandbox.map((s) => ({
                id: s.runtime_id,
                label: s.name,
                sub: `${s.sessions.toLocaleString()} ${t.usage.sessions}`,
                value: formatCompact(s.sandbox_minutes),
                unit: t.usage.minutesUnit,
                share: s.sandbox_minutes / sandboxTotalMinutes,
              }))}
            />
          </section>
        )}

        {/* The itemized ledger lives one level down — on-demand detail,
            not part of the daily dashboard read. */}
        <div className="flex justify-end">
          <Link
            to={`/usage/ledger?from=${from}&to=${to}`}
            className="text-[13px] text-fg-muted hover:text-brand transition-colors"
          >
            {t.usage.ledgerTitle} →
          </Link>
        </div>
      </div>
    </div>
  );
}
