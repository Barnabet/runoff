import type { FlagRow } from "@/lib/api";

/**
 * A margin-note flag card in the Reader's right rail. Open: a `bg-card` card with
 * a 2px amber top border, the mono flag code, the serif question, and the option
 * pills (first solid, rest outline). Resolving posts the chosen option and the
 * card collapses to a `bg-wash` italic result line. `onResolve` owns the optimistic
 * update + banner flip in the parent.
 */
export function FlagCard({
  flag,
  onResolve,
}: {
  flag: FlagRow;
  onResolve: (flag: FlagRow, option: string) => void;
}) {
  if (flag.status !== "open") {
    const option = flag.resolution?.option ?? "";
    return (
      <div
        data-testid={`flag-card-${flag.id}`}
        data-state="resolved"
        className="bg-wash p-[12px] font-serif text-[12px] italic text-ink/60"
      >
        <span className="font-mono not-italic text-ink/70">{flag.code}</span> — {option} ✓
      </div>
    );
  }

  return (
    <div
      data-testid={`flag-card-${flag.id}`}
      data-state="open"
      className="border border-t-2 border-ink/12 border-t-amber-accent bg-card p-[14px]"
    >
      <div className="mb-[6px] font-mono text-[10.5px] font-medium tracking-[1px] text-amber">
        {flag.code}
      </div>
      <p className="font-serif text-[13px] leading-[1.5] text-ink">{flag.question}</p>
      <div className="mt-[10px] flex flex-wrap gap-[8px]">
        {flag.options.map((option, i) => (
          <button
            key={option}
            type="button"
            onClick={() => onResolve(flag, option)}
            className={
              i === 0
                ? "rounded-full bg-ink px-[13px] py-[5px] font-sans text-[11px] font-medium text-paper"
                : "rounded-full border border-ink/30 px-[13px] py-[5px] font-sans text-[11px] font-medium text-ink"
            }
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
