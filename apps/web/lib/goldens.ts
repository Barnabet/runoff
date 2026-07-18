import { join } from "node:path";
import { blocksToPlainText, type GoldenRow, type RunDocument, type RunoffDb } from "@runoff/core";
import { buildSourcePack, packForPrompt, type GoldenSummary } from "@runoff/engine";

const SELECT =
  "SELECT id, blueprint_id AS blueprintId, kind, run_id AS runId, section_key AS sectionKey, name, mime, stored_filename AS storedFilename, note, created_at AS createdAt FROM goldens";

export function listGoldens(db: RunoffDb, blueprintId: string): GoldenRow[] {
  return db.sqlite.prepare(`${SELECT} WHERE blueprint_id = ? ORDER BY rowid DESC`).all(blueprintId) as GoldenRow[];
}

export function listGoldenSummaries(db: RunoffDb, blueprintId: string): GoldenSummary[] {
  return listGoldens(db, blueprintId).map((g) => ({
    id: g.id,
    kind: g.kind,
    label:
      g.kind === "exemplar"
        ? (g.name ?? "exemplar")
        : `run ${g.runId}${g.kind === "section" ? ` §${g.sectionKey}` : ""}`,
    note: g.note,
  }));
}

/** Full text of one golden: run document (or one section of it), or the parsed exemplar file. */
export async function resolveGoldenText(
  db: RunoffDb,
  goldenId: string,
): Promise<{ description: string; text: string } | null> {
  const g = db.sqlite.prepare(`${SELECT} WHERE id = ?`).get(goldenId) as GoldenRow | undefined;
  if (!g) return null;

  if (g.kind === "exemplar") {
    if (!g.storedFilename) return null;
    const filesDir = process.env.RUNOFF_FILES_DIR ?? "data/files";
    const pack = await buildSourcePack([
      { id: g.id, name: g.name ?? "exemplar", mime: g.mime ?? "text/plain", path: join(filesDir, g.storedFilename) },
    ]);
    return { description: `Uploaded exemplar "${g.name ?? "exemplar"}"`, text: packForPrompt(pack, [g.id], 40) };
  }

  const row = db.sqlite.prepare("SELECT document FROM runs WHERE id = ?").get(g.runId) as { document: string | null } | undefined;
  if (!row?.document) return null;
  const doc = JSON.parse(row.document) as RunDocument;
  if (g.kind === "section") {
    const s = doc.sections.find((x) => x.key === g.sectionKey);
    if (!s) return null;
    return { description: `Golden section "${s.heading}" from run ${g.runId}`, text: blocksToPlainText(s.blocks) };
  }
  const text = doc.sections.map((s) => `${s.heading}\n${blocksToPlainText(s.blocks)}`).join("\n\n");
  return { description: `Golden run ${g.runId} ("${doc.title}")`, text };
}
