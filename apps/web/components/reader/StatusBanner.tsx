/**
 * The full-width strip under the Reader topbar. While any flag is open it is an
 * amber wash with a `N FLAGS` badge and italic serif copy calling for judgment;
 * once every flag is cleared it flips to a solid ink banner whose copy depends on
 * the delivery setting. No email is ever sent — the copy says the report is
 * *ready for delivery*, never that it was delivered.
 */
export function StatusBanner({
  openCount,
  delivery,
}: {
  openCount: number;
  delivery: { recipient: string; autoDeliverOnClear: boolean };
}) {
  if (openCount > 0) {
    const passages =
      openCount === 1
        ? "One passage awaits your judgment — clearing it releases the report for delivery."
        : `${openCount} passages await your judgment — clearing them releases the report for delivery.`;
    return (
      <div
        data-testid="status-banner"
        data-state="open"
        className="no-print flex items-center gap-[14px] border-b border-amber-accent bg-amber-accent/14 px-[40px] py-[11px]"
      >
        <span className="rounded-[3px] border border-amber-accent px-[6px] py-[2px] font-mono text-[8.5px] font-medium uppercase tracking-[1px] text-amber">
          {openCount} {openCount === 1 ? "Flag" : "Flags"}
        </span>
        <span className="font-serif text-[13px] italic text-amber">{passages}</span>
      </div>
    );
  }

  const cleared = delivery.autoDeliverOnClear
    ? `Cleared. Ready for delivery to ${delivery.recipient || "the recipient"}. ✓`
    : "Cleared. Auto-delivery is off — export when ready.";
  return (
    <div
      data-testid="status-banner"
      data-state="cleared"
      className="no-print flex items-center gap-[14px] bg-ink px-[40px] py-[11px] text-paper"
    >
      <span className="rounded-[3px] border border-paper/60 px-[6px] py-[2px] font-mono text-[8.5px] font-medium uppercase tracking-[1px] text-paper">
        Cleared
      </span>
      <span className="font-serif text-[13px] italic text-paper">{cleared}</span>
    </div>
  );
}
