const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Source freshness turns stale once its last-touched timestamp passes this age.
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse an ISO / SQLite timestamp into a Date. SQLite's `datetime('now')` yields
 * `2026-07-01 09:14:00` (UTC, no `T`/`Z`); normalise it so parsing is
 * timezone-stable. Returns null for null/unparseable input.
 */
function parseTs(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a timestamp as a mono ledger date like `JUL 1`. Returns `""` for
 * null/unparseable.
 */
export function fmtDate(iso: string | null | undefined): string {
  const d = parseTs(iso);
  if (!d) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * A compact "time ago" ledger value: `2M` (minutes), `3H` (hours), `5D` (days).
 * Sub-minute ages and future skew both round up to `1M`. Returns `""` for
 * null/unparseable input. Callers frame it (e.g. `✓ 2M AGO`).
 */
export function fmtRel(iso: string | null | undefined): string {
  const d = parseTs(iso);
  if (!d) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 60) return `${Math.max(1, min)}M`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}H`;
  return `${Math.floor(hr / 24)}D`;
}

/** True when a source's freshness timestamp is older than the stale threshold. */
export function isStale(iso: string | null | undefined): boolean {
  const d = parseTs(iso);
  if (!d) return false;
  return Date.now() - d.getTime() > STALE_MS;
}
