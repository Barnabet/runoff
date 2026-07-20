import type { RunoffDb } from "./db/index.js";
import { readWarehouseTables } from "./warehouse.js";
import type { CatalogFamily } from "./types/catalog.js";

/** Families → warehouse tables/columns/counts for one project. Server-only (root barrel, NOT /client-value-safe beyond types). */
export function buildWarehouseCatalog(db: RunoffDb, projectId: string): CatalogFamily[] {
  const fams = db.sqlite
    .prepare("SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key")
    .all(projectId) as Pick<CatalogFamily, "id" | "key" | "label" | "kind" | "granularity">[];
  const periodsStmt = db.sqlite.prepare(
    "SELECT period FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
  );
  return fams.map((f) => {
    const tables = readWarehouseTables(projectId, f.key);
    return {
      ...f,
      queryable: tables.length > 0,
      tables,
      filedPeriods: f.kind === "constant" ? [] : (periodsStmt.all(f.id) as { period: string }[]).map((r) => r.period),
    };
  });
}
