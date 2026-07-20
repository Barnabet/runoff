// The catalog SHAPE now lives in @runoff/core; the engine re-exports it so
// existing `import type { CatalogFamily } from "@runoff/engine"` sites are
// unchanged, and owns the serialization below.
export type { CatalogFamily, CatalogTable } from "@runoff/core";
import type { CatalogFamily, CatalogTable } from "@runoff/core";

function familyHead(f: CatalogFamily): string {
  const gran = f.kind === "periodic" ? `periodic, ${f.granularity}` : "constant";
  const filed = f.filedPeriods.length ? `; filed: ${f.filedPeriods.join(", ")}` : "";
  return `${f.key} — "${f.label}" (${gran}${filed})`;
}

function tableLine(t: CatalogTable): string {
  const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
  const counts = Object.entries(t.rowCounts);
  const total = counts.reduce((a, [, n]) => a + n, 0);
  const perPeriod = counts.length > 1 || (counts.length === 1 && counts[0][0] !== "")
    ? ` (${counts.map(([p, n]) => `${p}: ${n}`).join(", ")})`
    : "";
  return `  ${t.name}(${cols}) — ${total.toLocaleString("en-US")} rows${perPeriod}`;
}

/** ~2 lines per table; document families collapse to one annotated line. */
export function serializeCatalog(families: CatalogFamily[]): string {
  return families
    .map((f) => (f.queryable ? [familyHead(f), ...f.tables.map(tableLine)].join("\n") : `${familyHead(f)} — document, not queryable`))
    .join("\n");
}
