"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatPeriod } from "@runoff/core/client";
import { createRun, getRunOptionsApi, type RunOptions } from "@/lib/api";

/** The server's `{ error }` string out of a rejected fetchJson promise. */
function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/\{.*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // fall through
    }
  }
  return "Could not start the run.";
}

function Check({ label, present }: { label: string; present: boolean }) {
  return present ? (
    <li className="font-serif text-[13px] text-ink">{`✓ ${label}`}</li>
  ) : (
    <li className="font-serif text-[13px] italic text-pencil">{`✗ ${label} — missing`}</li>
  );
}

/**
 * The run trigger dialog. Fetches the blueprint's run options on open, lets the
 * user pick a period (periodic blueprints) and shows a per-period source-gap
 * checklist, then POSTs the run and routes to its Live page. Constants-only
 * blueprints show only the checklist and run with no period.
 */
export function RunDialog({ blueprintId, onClose }: { blueprintId: string; onClose: () => void }) {
  const router = useRouter();
  const [options, setOptions] = useState<RunOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [period, setPeriod] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getRunOptionsApi(blueprintId)
      .then((opts) => {
        if (!live) return;
        setOptions(opts);
        setPeriod(opts.periods[0]?.period ?? null);
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [blueprintId]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setRunError(null);
    try {
      const { id } = await createRun(blueprintId, period);
      router.push(`/runs/${id}`);
    } catch (err) {
      setBusy(false);
      setRunError(errMsg(err));
    }
  }

  const selectedRow = options?.periods.find((p) => p.period === period) ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/[0.38] px-4"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-label="Run this blueprint"
        className="w-[440px] max-w-full bg-card p-7 shadow-[0_14px_44px_rgba(32,26,21,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-[22px] font-medium text-ink">Run this blueprint</h2>

        {loadError ? (
          <p className="mt-3 font-serif text-[13px] italic text-pencil">Could not load run options.</p>
        ) : !options ? (
          <p className="mt-3 font-serif text-[13px] italic text-ink/55">Loading…</p>
        ) : (
          <>
            {options.granularity !== null && (
              <>
                <label className="mt-5 block font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
                  Period
                </label>
                {options.periods.length === 0 ? (
                  <p className="mt-[6px] font-serif text-[13px] italic text-pencil">
                    No period has been filed for this blueprint yet.
                  </p>
                ) : (
                  <select
                    aria-label="period"
                    value={period ?? ""}
                    onChange={(e) => setPeriod(e.target.value)}
                    className="mt-[6px] w-full border border-ink/20 bg-paper px-3 py-2 font-serif text-[14px] text-ink outline-none focus:border-ink/40"
                  >
                    {options.periods.map((p) => (
                      <option key={p.period} value={p.period}>
                        {formatPeriod(p.period)}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            <ul className="mt-5 space-y-[6px]">
              {selectedRow?.families.map((f) => (
                <Check key={`p-${f.key}`} label={f.label} present={f.present} />
              ))}
              {options.constants.map((f) => (
                <Check key={`c-${f.key}`} label={f.label} present={f.present} />
              ))}
            </ul>

            {runError && (
              <p className="mt-4 font-serif text-[12.5px] italic text-pencil">{runError}</p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-full border border-ink/30 px-4 py-2 font-sans text-[12px] font-medium text-ink/70 disabled:opacity-50"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={busy || (options.granularity !== null && period === null)}
                className="rounded-full bg-ink px-5 py-2 font-serif text-[14px] text-paper disabled:opacity-60"
              >
                {busy ? "Starting…" : "Run"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
