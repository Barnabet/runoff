/**
 * The DELIVERY card in the Reader's right rail: the recipient in mono (or an
 * italic "no recipient set") and an "Auto-deliver on clear" toggle. The toggle is
 * a controlled pill — the parent owns the state and the persistence (fetch the
 * current blueprint content, flip the flag, save a revision, revert on failure).
 */
export function DeliveryCard({
  recipient,
  autoDeliver,
  onToggle,
}: {
  recipient: string;
  autoDeliver: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-testid="delivery-card" className="border border-ink/12 bg-card p-[16px]">
      <div className="mb-[10px] font-sans text-[9.5px] font-semibold uppercase tracking-[2px] text-ink/45">
        Delivery
      </div>
      {recipient ? (
        <p className="font-mono text-[10.5px] text-ink/80">{recipient}</p>
      ) : (
        <p className="font-serif text-[12px] italic text-ink/45">no recipient set</p>
      )}
      <div className="mt-[12px] flex items-center justify-between gap-[10px]">
        <span className="font-sans text-[11.5px] text-ink/70">Auto-deliver on clear</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoDeliver}
          aria-label="Auto-deliver on clear"
          onClick={onToggle}
          className={`relative h-[17px] w-[30px] rounded-full transition-colors duration-200 ${
            autoDeliver ? "bg-ink" : "bg-ink/25"
          }`}
        >
          <span
            className={`absolute top-[2px] h-[13px] w-[13px] rounded-full bg-paper transition-all duration-200 ${
              autoDeliver ? "left-[15px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
