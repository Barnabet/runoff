"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadSource } from "@/lib/api";
import { showToast } from "@/components/Toast";

type KindKey = "file" | "db" | "api" | "drive" | "web" | "text";

const KINDS: { key: KindKey; title: string; sub: string; enabled: boolean }[] = [
  { key: "file", title: "Upload a file", sub: "CSV · XLSX · PDF · DOCX", enabled: true },
  { key: "db", title: "Database", sub: "POSTGRES · MYSQL", enabled: false },
  { key: "api", title: "SaaS API", sub: "GA4 · STRIPE · HUBSPOT", enabled: false },
  { key: "drive", title: "Cloud drive", sub: "DRIVE · DROPBOX", enabled: false },
  { key: "web", title: "Web research", sub: "LIVE WEB QUERIES", enabled: false },
  { key: "text", title: "Paste text", sub: "RAW SNIPPET", enabled: false },
];

/**
 * The connect-source modal: a scrim-centered 600px paper card. A 3×2 grid of
 * kind cards gates the flow — only "Upload a file" is wired in v1; the rest sit
 * at reduced opacity and toast "Coming soon". Picking file reveals a file input
 * and a name field (defaulting to the file name); "Test & continue →" uploads,
 * closes, refreshes the ledger, and toasts. Scrim click / Cancel / Escape close.
 */
export function AddSourceModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [picked, setPicked] = useState<KindKey | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // Escape closes the modal (unless a submit is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function close() {
    if (busy) return;
    onClose();
  }

  function pickKind(kind: (typeof KINDS)[number]) {
    if (!kind.enabled) {
      showToast("Coming soon");
      return;
    }
    setPicked(kind.key);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0] ?? null;
    setFile(chosen);
    // Default the name field to the chosen file's name.
    if (chosen) setName(chosen.name);
  }

  async function submit() {
    if (busy || !file) return;
    setBusy(true);
    try {
      await uploadSource(file, name.trim() || file.name);
      onClose();
      router.refresh();
      showToast("Source connected");
    } catch {
      setBusy(false);
      showToast("Couldn't connect the source.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/[0.38] px-4"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Add a source"
        className="w-[600px] max-w-full bg-card p-7 shadow-[0_14px_44px_rgba(32,26,21,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-[22px] font-medium text-ink">Add a source</h2>
          <div className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink/45">
            1 CHOOSE —{" "}
            <span className={picked ? "font-bold text-ink" : ""}>2 CONNECT</span> — 3
            MAP FIELDS
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          {KINDS.map((kind) => {
            const on = picked === kind.key;
            return (
              <button
                key={kind.key}
                type="button"
                onClick={() => pickKind(kind)}
                aria-pressed={on}
                className={`flex flex-col items-start gap-[3px] p-[14px] text-left transition-colors ${
                  on
                    ? "border-[1.5px] border-ink bg-wash"
                    : "border border-ink/15 bg-card"
                } ${kind.enabled ? "" : "opacity-45"}`}
              >
                <span className="font-serif text-[14px] text-ink">{kind.title}</span>
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-ink/45">
                  {kind.sub}
                </span>
              </button>
            );
          })}
        </div>

        {picked === "file" && (
          <div className="mt-6">
            <label className="block font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
              File
            </label>
            <input
              type="file"
              accept=".csv,.xlsx,.pdf,.docx"
              aria-label="Choose a file"
              onChange={onFileChange}
              className="mt-[6px] block w-full font-mono text-[11px] text-ink/70 file:mr-3 file:cursor-pointer file:border file:border-ink/25 file:bg-paper file:px-3 file:py-[6px] file:font-sans file:text-[11px] file:text-ink"
            />

            <label className="mt-4 block font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Spend — June"
              aria-label="Source name"
              className="mt-[6px] w-full border border-ink/20 bg-paper px-3 py-2 font-serif text-[14px] text-ink outline-none placeholder:italic placeholder:text-ink/40 focus:border-ink/40"
            />
          </div>
        )}

        <p className="mt-6 font-serif text-[13px] italic text-ink/45">
          Read-only, encrypted at rest. The agent queries; it never writes.
        </p>

        <div className="mt-4 flex justify-end gap-2">
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
            disabled={busy || !file}
            className="rounded-full bg-ink px-4 py-2 font-sans text-[12px] font-medium text-paper disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Test & continue →"}
          </button>
        </div>
      </div>
    </div>
  );
}
