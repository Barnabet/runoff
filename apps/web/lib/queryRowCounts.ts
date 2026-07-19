import { runWarehouseSql } from "@runoff/core";
import type { BlueprintContent } from "@runoff/core";
import type { getDb } from "./db";

/**
 * Per-query row counts for a blueprint's baked section queries, bound to the
 * project's latest filed period. Shape: sectionKey → query name → count
 * (`null` when the query fails to compile or run). Sections without queries are
 * omitted. Used by the Builder to render read-only `<name> — <n> rows` chips.
 */
export function computeQueryRowCounts(
  db: ReturnType<typeof getDb>,
  projectId: string,
  content: BlueprintContent,
): Record<string, Record<string, number | null>> {
  const latest = (
    db.sqlite
      .prepare(
        "SELECT MAX(period) AS p FROM sources WHERE project_id = ? AND status='filed' AND period IS NOT NULL",
      )
      .get(projectId) as { p: string | null }
  ).p;

  const queryRowCounts: Record<string, Record<string, number | null>> = {};
  for (const s of content.sections) {
    if (!s.queries.length) continue;
    queryRowCounts[s.key] = {};
    for (const qy of s.queries) {
      try {
        const res = runWarehouseSql(projectId, `SELECT COUNT(*) FROM (${qy.sql})`, { period: latest });
        queryRowCounts[s.key][qy.name] = (res.rows[0]?.[0] as number) ?? null;
      } catch {
        queryRowCounts[s.key][qy.name] = null;
      }
    }
  }
  return queryRowCounts;
}
