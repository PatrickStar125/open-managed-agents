/**
 * Format a millisecond duration as a short human label:
 * `<1ms`, `123ms`, `1.23s`, `2m17s`. Used in timeline bars + tooltips
 * + turn headers — anywhere we want a compact "took X" indicator.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * "12s ago" / "5m ago" / "3d ago" / "8mo ago" — coarse relative time
 * suitable for header chips. Prefer absolute timestamps in tooltips
 * when an exact value matters.
 */
export function formatRelative(diffMs: number): string {
  if (diffMs < 0) diffMs = -diffMs;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Truncate a long ID like `agt_01ABCDEF...XYZ` to a few-char prefix +
 * ellipsis + suffix, used as a fallback label when the resource's
 * display name hasn't loaded yet. Better than rendering 30 chars of
 * opaque hex in a badge.
 */
export function shortenId(id: string | undefined): string {
  if (!id) return "—";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "…" + id.slice(-3);
}

/**
 * Snap a time-axis tick step to a friendly unit. Caller passes the
 * total span the chart covers; helper picks the smallest candidate
 * that still keeps tick count near 6. Used by the Timeline waterfall.
 */
export function pickTickStep(totalMs: number): number {
  const target = totalMs / 6;
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1];
}

/** Compact number for tiles/axis/table cells: 1_234_567 → "1.2M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim1(n / 1_000)}K`;
  if (abs < 1_000_000_000) return `${trim1(n / 1_000_000)}M`;
  return `${trim1(n / 1_000_000_000)}G`;
}

function trim1(v: number): string {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return String(r);
}

// ── UTC day-granularity date helpers (YYYY-MM-DD) ─────────────────────────

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoAdd(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}
