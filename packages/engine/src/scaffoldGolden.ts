import type { BindingInventory, BindingItem, Block, RunDocument } from "@runoff/core";
import { boundnessLine } from "./goldenBinding.js";

export interface ScaffoldGoldenInput {
  id: string;
  label: string;
  period: string | null;
  document: RunDocument;
  inventory: BindingInventory;
}
export interface ScaffoldQuery { name: string; sql: string; provenance: "verified" | "verified-mismatch" }
export interface ScaffoldSection { key: string; heading: string; prose: string; queries: ScaffoldQuery[]; warnings: string[] }
export interface ScaffoldDigest {
  goldenId: string;
  label: string;
  period: string | null;
  boundness: string;
  sections: ScaffoldSection[];
}

const PROSE_CAP = 1500;

/** Spec §2.3: spans joined with a space; tables header-only; blocks joined with \n; capped. */
function serializeProse(blocks: Block[]): string {
  const text = blocks
    .map((b) =>
      b.type === "paragraph"
        ? b.spans.map((sp) => sp.text).join(" ")
        : `[table ${b.columns.length} cols × ${b.rows.length} rows: ${b.columns.join(" | ")}]`,
    )
    .join("\n");
  return text.length > PROSE_CAP ? `${text.slice(0, PROSE_CAP)}…` : text;
}

/** Spec §2.2: one digest section per document section (document order); bound/mismatch SQL lifted, the rest becomes warnings. */
export function buildScaffoldDigest(g: ScaffoldGoldenInput): ScaffoldDigest {
  const bySection = new Map<string, BindingItem[]>();
  for (const it of g.inventory.items) {
    const list = bySection.get(it.anchor.sectionKey) ?? [];
    list.push(it);
    bySection.set(it.anchor.sectionKey, list);
  }
  const sections = g.document.sections.map((s) => {
    const queries: ScaffoldQuery[] = [];
    const warnings: string[] = [];
    const used = new Set<string>();
    for (const it of bySection.get(s.key) ?? []) {
      const b = it.binding;
      if (b && (b.status === "bound" || b.status === "mismatch")) {
        let name = it.id;
        for (let i = 2; used.has(name); i++) name = `${it.id}_${i}`;
        used.add(name);
        queries.push({ name, sql: b.sql, provenance: b.status === "bound" ? "verified" : "verified-mismatch" });
        if (b.status === "mismatch") {
          warnings.push(`"${it.raw}" mismatches current data (golden says ${it.raw} · data ${String(b.verifiedValue)})`);
        }
      } else {
        warnings.push(`"${it.raw}" has no data backing (${it.reason ?? "unbound"})`);
      }
    }
    if (queries.length === 0) warnings.push("no verified queries in this section");
    return { key: s.key, heading: s.heading, prose: serializeProse(s.blocks), queries, warnings };
  });
  return { goldenId: g.id, label: g.label, period: g.period, boundness: boundnessLine(g.inventory), sections };
}

/** Spec §2.4. SQL is NOT truncated here — the agent lifts it verbatim. */
export function renderScaffoldDigest(d: ScaffoldDigest): string {
  const lines = [`SCAFFOLD DIGEST — golden "${d.label}" (period ${d.period ?? "none"}, ${d.boundness})`];
  for (const s of d.sections) {
    lines.push("", `## section: ${s.key} — ${s.heading}`, "prose:", s.prose);
    if (s.queries.length) {
      lines.push("queries:");
      for (const q of s.queries) lines.push(`  ${q.name}: ${q.sql}  [${q.provenance}]`);
    }
    if (s.warnings.length) {
      lines.push("warnings:");
      for (const w of s.warnings) lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}
