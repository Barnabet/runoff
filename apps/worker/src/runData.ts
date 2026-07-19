import { readWarehouseTables, runWarehouseSql, type RunoffDb } from "@runoff/core";
import type { CatalogFamily, RunData } from "@runoff/engine";

/**
 * The run's warehouse window. Mirrors apps/web/lib/catalog.ts (the catalog
 * builder cannot live in core — CatalogFamily is an engine type — so worker and
 * web each own a thin copy; keep them in sync). Restricts the catalog to the
 * blueprint's bound families and pins `exec` to the run's period.
 */
export function buildRunData(
  db: RunoffDb,
  projectId: string,
  boundFamilyIds: string[],
  period: string | null,
): RunData {
  const fams = db.sqlite
    .prepare("SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key")
    .all(projectId) as Pick<CatalogFamily, "id" | "key" | "label" | "kind" | "granularity">[];
  const periodsStmt = db.sqlite.prepare(
    "SELECT period FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
  );
  const bound = new Set(boundFamilyIds);
  const catalog: CatalogFamily[] = fams
    .filter((f) => bound.has(f.id))
    .map((f) => {
      const tables = readWarehouseTables(projectId, f.key);
      return {
        ...f,
        queryable: tables.length > 0,
        tables,
        filedPeriods: f.kind === "constant" ? [] : (periodsStmt.all(f.id) as { period: string }[]).map((r) => r.period),
      };
    });
  return { catalog, exec: (sql) => runWarehouseSql(projectId, sql, { period }) };
}
