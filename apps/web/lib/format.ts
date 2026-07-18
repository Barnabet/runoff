const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/**
 * Format an ISO / SQLite timestamp as a mono ledger date like `JUL 1`.
 * SQLite's `datetime('now')` yields `2026-07-01 09:14:00` (UTC, no `T`/`Z`);
 * normalise it so parsing is timezone-stable. Returns `""` for null/unparseable.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
