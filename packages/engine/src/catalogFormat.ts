// The engine owns the catalog SHAPE (the web/eval callers build it), mirroring
// how FamilyInfo works for the copilot context.

export interface CatalogTable {
  name: string;
  columns: { name: string; type: "INTEGER" | "REAL" | "TEXT" }[];
  rowCounts: Record<string, number>;
}

export interface CatalogFamily {
  id: string;
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: "quarter" | "month" | "year" | null;
  queryable: boolean;
  tables: CatalogTable[];
  filedPeriods: string[];
}

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
