import { join } from "node:path";
import type { RunoffDb } from "@runoff/core";
import type { EngineFile } from "@runoff/engine";

/**
 * Resolve a blueprint's bound families to concrete files for one run period.
 * EngineFile.id is the FAMILY id, so locators/citations (sum(fam_x.amount))
 * stay stable across periods. gaps carries the keys of bound families with no
 * live file in the slot; the run proceeds without them.
 */
export function resolveRunSources(
  db: RunoffDb,
  blueprintId: string,
  period: string | null,
): { files: EngineFile[]; gaps: string[] } {
  const filesDir = process.env.RUNOFF_FILES_DIR ?? "data/files";
  const fams = db.sqlite
    .prepare(
      `SELECT f.id, f.key, f.label, f.kind FROM blueprint_families bf
       JOIN source_families f ON f.id = bf.family_id WHERE bf.blueprint_id = ? ORDER BY f.key`,
    )
    .all(blueprintId) as { id: string; key: string; label: string; kind: string }[];
  const slot = db.sqlite.prepare(
    "SELECT mime, stored_filename AS storedFilename FROM sources WHERE family_id = ? AND status='filed' AND period IS ?",
  );
  const files: EngineFile[] = [];
  const gaps: string[] = [];
  for (const f of fams) {
    const row = slot.get(f.id, f.kind === "constant" ? null : period) as
      | { mime: string; storedFilename: string }
      | undefined;
    if (!row) {
      gaps.push(f.key);
      continue;
    }
    files.push({ id: f.id, name: f.label, mime: row.mime, path: join(filesDir, row.storedFilename) });
  }
  return { files, gaps };
}
