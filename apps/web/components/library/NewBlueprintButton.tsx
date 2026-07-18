"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBlueprint } from "@/lib/api";
import { showToast } from "@/components/Toast";

/**
 * The topbar "New blueprint" pill. Opens a minimal name + client modal, POSTs a
 * blueprint, and routes to its Builder. Scheduling/sources are set there later.
 */
export function NewBlueprintButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setOpen(false);
    setName("");
    setClient("");
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("Name the blueprint first.");
      return;
    }
    setBusy(true);
    try {
      const { id } = await createBlueprint({ name: trimmed, clientName: client.trim() });
      router.push(`/blueprints/${id}`);
    } catch {
      setBusy(false);
      showToast("Couldn't create the blueprint.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-ink px-4 py-2 font-sans text-[12.5px] font-medium text-paper"
      >
        New blueprint
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/[0.38] px-4"
          onClick={close}
        >
          <div
            className="w-[420px] max-w-full bg-card p-7 shadow-[0_14px_44px_rgba(32,26,21,0.3)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-[22px] font-medium text-ink">New blueprint</h2>
            <p className="mt-1 font-serif text-[13px] italic text-ink/55">
              Name it and who it&rsquo;s for — you&rsquo;ll shape the rest in the builder.
            </p>

            <label className="mt-5 block font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
              Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Monthly Performance Report"
              className="mt-[6px] w-full border border-ink/20 bg-paper px-3 py-2 font-serif text-[14px] text-ink outline-none placeholder:italic placeholder:text-ink/40 focus:border-ink/40"
            />

            <label className="mt-4 block font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
              Client
            </label>
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Meridian Retail"
              className="mt-[6px] w-full border border-ink/20 bg-paper px-3 py-2 font-serif text-[14px] text-ink outline-none placeholder:italic placeholder:text-ink/40 focus:border-ink/40"
            />

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-full border border-ink/30 px-4 py-2 font-sans text-[12px] font-medium text-ink/70 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="rounded-full bg-ink px-4 py-2 font-sans text-[12px] font-medium text-paper disabled:opacity-60"
              >
                {busy ? "Creating…" : "Create →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
