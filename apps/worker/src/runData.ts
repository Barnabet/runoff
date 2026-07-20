import { buildWarehouseCatalog, runWarehouseSql, type RunoffDb } from "@runoff/core";
import type { RunData } from "@runoff/engine";

/**
 * The run's warehouse window: the shared core catalog restricted to the
 * blueprint's bound families, with `exec` pinned to the run's period.
 */
export function buildRunData(
  db: RunoffDb,
  projectId: string,
  boundFamilyIds: string[],
  period: string | null,
): RunData {
  const bound = new Set(boundFamilyIds);
  const catalog = buildWarehouseCatalog(db, projectId).filter((f) => bound.has(f.id));
  return { catalog, exec: (sql) => runWarehouseSql(projectId, sql, { period }) };
}
