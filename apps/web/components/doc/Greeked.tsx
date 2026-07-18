/**
 * A "greeked" placeholder: horizontal ink stripes standing in for content that
 * renders at run time (channel tables, appendix pages), with an optional mono
 * caption below. `lines` sizes the block at ~20px per greeked line.
 *
 * Server-safe: pure presentational, no hooks / no "use client".
 */
export function Greeked({ lines, caption }: { lines: number; caption?: string }) {
  return (
    <div>
      <div
        style={{
          height: `${lines * 20}px`,
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(32,26,21,0.08) 0 9px, transparent 9px 20px)",
        }}
      />
      {caption ? (
        <div className="mt-[8px] font-mono text-[10.5px] text-ink/45">{caption}</div>
      ) : null}
    </div>
  );
}
