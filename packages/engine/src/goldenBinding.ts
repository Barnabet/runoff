import type {
  BindingInventory, BindingItem, RunDocument, SqlResult, SubmittedInventory, SubmittedItem,
} from "@runoff/core";
import type { CatalogFamily } from "./catalogFormat.js";
import { compileLocator } from "./checks.js";

/** "$4,215,332" → 4215332 · "$4.2M" → 4200000 · "12.5%" → 0.125 · non-numeric → null. */
export function parseSpanNumber(text: string): number | null {
  const t = text.trim().replace(/^[~≈]/, "");
  const m = /^[$€£]?\s*(-?\d[\d,\s]*(?:\.\d+)?)\s*([KMB])?\s*(%)?$/i.exec(t);
  if (!m) return null;
  let n = Number(m[1].replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as "K" | "M" | "B"];
  if (m[3]) n /= 100;
  return n;
}

const numbersMatch = (verified: number, parsed: number): boolean =>
  Math.abs(verified - parsed) <= Math.max(0.005, 0.01 * Math.abs(parsed));

/**
 * Execute every submitted binding and stamp verifiedValue + status (spec §6).
 * `doc` is required to verify table col/row counts; value-only inventories may omit it.
 * Re-verifying a stored inventory re-derives every stamp from scratch.
 */
export function verifyInventory(
  inv: { version: 1; items: (SubmittedItem | BindingItem)[] },
  exec: (sql: string) => SqlResult,
  period: string | null,
  doc?: RunDocument,
): BindingInventory {
  const items: BindingItem[] = inv.items.map((it) => {
    if (!it.binding) return { ...it, binding: null, reason: it.reason ?? "unbound" };
    const { familyId, sql } = it.binding;
    const fail = (status: "mismatch" | "error", reason: string | null, verifiedValue: number | string | null = null): BindingItem =>
      ({ ...it, binding: { familyId, sql, verifiedValue, status }, reason });
    if (period === null && /:period\b/.test(sql)) return fail("error", "golden has no period");
    let result: SqlResult;
    try { result = exec(sql); } catch (e) {
      return fail("error", `sql error: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    if (it.kind === "table") {
      const block = doc?.sections.find((s) => s.key === it.anchor.sectionKey)?.blocks[it.anchor.blockIndex];
      const want = block && block.type === "table" ? { cols: block.columns.length, rows: block.rows.length } : null;
      if (want && result.columns.length !== want.cols) return fail("mismatch", `column count ${result.columns.length} ≠ ${want.cols}`, result.rows.length);
      if (want && result.rows.length !== want.rows) return fail("mismatch", `row count ${result.rows.length} ≠ ${want.rows}`, result.rows.length);
      return { ...it, binding: { familyId, sql, verifiedValue: result.rows.length, status: "bound" }, reason: null };
    }
    if (result.rows.length !== 1 || result.columns.length !== 1) return fail("error", "sql did not return a single value");
    const cell = result.rows[0][0];
    const verified: number | string | null = typeof cell === "number" || typeof cell === "string" ? cell : cell === null ? null : String(cell);
    if (it.parsed === null)
      return verified === null ? fail("error", "sql did not return a single value")
        : { ...it, binding: { familyId, sql, verifiedValue: verified, status: "bound" }, reason: null };
    const ok = typeof it.parsed === "number"
      ? typeof verified === "number" && numbersMatch(verified, it.parsed)
      : typeof verified === "string" && verified.trim().toLowerCase() === it.parsed.trim().toLowerCase();
    return ok
      ? { ...it, binding: { familyId, sql, verifiedValue: verified, status: "bound" }, reason: null }
      : fail("mismatch", "value mismatch", verified);
  });
  return { version: 1, items };
}

export function boundnessLine(inv: BindingInventory | null): string {
  if (!inv) return "not yet bound";
  if (inv.items.length === 0) return "nothing to bind";
  const bound = inv.items.filter((i) => i.binding?.status === "bound").length;
  const mismatch = inv.items.filter((i) => i.binding?.status === "mismatch").length;
  return `${bound}/${inv.items.length} bound, ${mismatch} mismatch, ${inv.items.length - bound - mismatch} unbound`;
}

/**
 * Deterministic inventory for run/section goldens (spec §4): spans with
 * citations → value items via compileLocator; table blocks → the section's
 * first covering query (SQL references exactly one catalog table name).
 * Item ids are anchor-derived and therefore stable across rebuilds.
 */
export function inventoryFromCitations(
  document: RunDocument,
  catalog: CatalogFamily[],
  queriesFor: (sectionKey: string) => { name: string; sql: string }[],
): SubmittedInventory {
  const items: SubmittedItem[] = [];
  const allTables = catalog.flatMap((f) => f.tables.map((t) => ({ name: t.name, familyId: f.id })));
  for (const section of document.sections) {
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === "paragraph") {
        block.spans.forEach((span, spanIndex) => {
          if (!span.citation) return;
          const base = {
            id: `${section.key}_b${blockIndex}_s${spanIndex}`, kind: "value" as const,
            anchor: { sectionKey: section.key, blockIndex, spanIndex },
            raw: span.text.slice(0, 200), parsed: parseSpanNumber(span.text),
          };
          try {
            const { sql, family } = compileLocator(span.citation.locator, catalog);
            items.push({ ...base, binding: { familyId: family.id, sql }, reason: null });
          } catch (e) {
            items.push({ ...base, binding: null, reason: String((e as Error).message ?? e) });
          }
        });
      } else {
        const base = {
          id: `${section.key}_b${blockIndex}`, kind: "table" as const,
          anchor: { sectionKey: section.key, blockIndex, spanIndex: null },
          raw: `table: ${block.columns.join(", ")}`.slice(0, 200), parsed: null,
        };
        const covering = queriesFor(section.key).find((q) => {
          const hits = allTables.filter((t) => new RegExp(`\\b${t.name}\\b`).test(q.sql));
          return hits.length >= 1 && new Set(hits.map((h) => h.familyId)).size === 1;
        });
        if (covering) {
          const familyId = allTables.find((t) => new RegExp(`\\b${t.name}\\b`).test(covering.sql))!.familyId;
          items.push({ ...base, binding: { familyId, sql: covering.sql }, reason: null });
        } else {
          items.push({ ...base, binding: null, reason: "no query covers this table" });
        }
      }
    });
  }
  return { version: 1, items: items.slice(0, 60) };
}

/** The one renderer every agent consumer uses (spec §8). */
export function renderGoldenForPrompt(g: {
  label: string; note: string | null; period: string | null;
  document: RunDocument | null; inventory: BindingInventory | null; unifyError: string | null;
}): string {
  if (!g.document) return `golden "${g.label}" is not unified (${g.unifyError ?? "no document"})`;
  const byAnchor = new Map<string, BindingItem>();
  for (const it of g.inventory?.items ?? [])
    byAnchor.set(`${it.anchor.sectionKey}|${it.anchor.blockIndex}|${it.anchor.spanIndex ?? "t"}`, it);
  const annotate = (raw: string, it: BindingItem | undefined): string => {
    if (!it?.binding || it.binding.status === "error") return raw;
    const sql = it.binding.sql.length > 120 ? `${it.binding.sql.slice(0, 120)}…` : it.binding.sql;
    const tag = it.binding.status === "mismatch" ? ` [MISMATCH: data says ${String(it.binding.verifiedValue)}]` : "";
    return `«${raw} ← ${it.binding.familyId}: ${sql}»${tag}`;
  };
  const lines: string[] = [`# ${g.document.title}`];
  if (g.note) lines.push(`note: ${g.note}`);
  if (g.period) lines.push(`period: ${g.period}`);
  for (const s of g.document.sections) {
    lines.push(`## ${s.heading}`);
    s.blocks.forEach((b, bi) => {
      if (b.type === "paragraph") {
        lines.push(b.spans.map((sp, si) => annotate(sp.text, byAnchor.get(`${s.key}|${bi}|${si}`))).join(""));
      } else {
        const it = byAnchor.get(`${s.key}|${bi}|t`);
        lines.push(annotate(`[table] ${b.columns.join(" | ")}`, it));
        for (const r of b.rows) lines.push(r.cells.map((c) => c.map((sp) => sp.text).join("")).join(" | "));
      }
    });
  }
  lines.push(`boundness: ${boundnessLine(g.inventory)}`);
  return lines.join("\n");
}
