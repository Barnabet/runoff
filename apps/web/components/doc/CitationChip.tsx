/**
 * Inline citation marker appended after a cited span. Shows the source's SHORT
 * label (e.g. `GA4`, `CSV`) — callers resolve sourceId → label upstream.
 *
 * Superscript, mono 8.5px, cite-purple text with a hairline bordered pill.
 * Server-safe: pure presentational, no hooks / no "use client".
 */
export function CitationChip({ label }: { label: string }) {
  return (
    <span className="mx-[2px] rounded-[3px] border border-cite/40 px-[4px] py-px align-[3px] font-mono text-[8.5px] font-medium text-cite">
      {label}
    </span>
  );
}
