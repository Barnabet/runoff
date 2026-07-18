import type { Granularity, RunoffDb } from "@runoff/core";

// The run options for a blueprint: which periods any bound periodic family has
// filed (descending), a per-period presence checklist across the bound periodic
// families, and the constant-family checklist. Pure read shared by GET
// /api/blueprints/:id/run-options, the RunDialog, and POST /api/runs validation.
// Never import this from client code — it touches the SQLite handle.

export interface RunOptions {
  /** Shared granularity of the bound periodic families, or null when none are bound. */
  granularity: Granularity | null;
  /** One row per period ANY bound periodic family has filed, latest first. */
  periods: { period: string; families: { key: string; label: string; present: boolean }[] }[];
  constants: { key: string; label: string; present: boolean }[];
}

export function getRunOptions(db: RunoffDb, blueprintId: string): RunOptions | null {
  const bp = db.sqlite.prepare("SELECT id FROM blueprints WHERE id = ?").get(blueprintId);
  if (!bp) return null;

  const fams = db.sqlite
    .prepare(
      `SELECT f.id, f.key, f.label, f.kind, f.granularity FROM blueprint_families bf
       JOIN source_families f ON f.id = bf.family_id WHERE bf.blueprint_id = ? ORDER BY f.key`,
    )
    .all(blueprintId) as { id: string; key: string; label: string; kind: string; granularity: Granularity | null }[];

  const periodic = fams.filter((f) => f.kind === "periodic");
  const constants = fams.filter((f) => f.kind === "constant");

  const liveStmt = db.sqlite.prepare(
    "SELECT 1 FROM sources WHERE family_id = ? AND status = 'filed' AND period IS NULL",
  );
  const periodStmt = db.sqlite.prepare(
    "SELECT period FROM sources WHERE family_id = ? AND status = 'filed' AND period IS NOT NULL",
  );

  const filedByFamily = new Map(
    periodic.map((f) => [f.id, new Set((periodStmt.all(f.id) as { period: string }[]).map((r) => r.period))]),
  );
  const allPeriods = [...new Set([...filedByFamily.values()].flatMap((s) => [...s]))].sort().reverse();

  return {
    granularity: periodic[0]?.granularity ?? null,
    periods: allPeriods.map((period) => ({
      period,
      families: periodic.map((f) => ({ key: f.key, label: f.label, present: filedByFamily.get(f.id)!.has(period) })),
    })),
    constants: constants.map((f) => ({ key: f.key, label: f.label, present: !!liveStmt.get(f.id) })),
  };
}
