import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifySource, isTabular, scanTabular, scanSample, type ClassifyFamily, type TabularScan } from "@runoff/engine";
import { computeDrift, readWarehouseTables } from "@runoff/core";
import { getDb } from "../../../../../../lib/db";
import { getLlmClient } from "../../../../../../lib/llm";
import { readContentSample, tableNamesFor } from "../../../../../../lib/sourceManager";

type Ctx = { params: Promise<{ id: string }> };

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

interface SourceRow {
  id: string;
  name: string;
  mime: string;
  storedFilename: string;
}

// POST /api/projects/:id/sources/classify — body { sourceIds: string[] }. For
// each still-unfiled row in this project, sample its content and ask the engine
// where it belongs; persist the proposal (or leave NULL when none). Returns the
// updated rows.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const project = db.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return Response.json({ error: "project not found" }, { status: 404 });

  let body: { sourceIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter((s): s is string => typeof s === "string") : [];

  const families = db.sqlite
    .prepare("SELECT key, label, kind, granularity FROM source_families WHERE project_id = ?")
    .all(id) as ClassifyFamily[];

  const client = getLlmClient();
  const dir = filesDir();
  const updated: { id: string; proposal: unknown }[] = [];

  for (const sourceId of sourceIds) {
    const row = db.sqlite
      .prepare("SELECT id, name, mime, stored_filename AS storedFilename FROM sources WHERE id = ? AND project_id = ? AND status = 'unfiled'")
      .get(sourceId, id) as SourceRow | undefined;
    if (!row) continue;

    // A file that fails to parse must not sink the rest of the batch: treat it
    // like classifySource's own null-on-failure contract (no proposal → user
    // files it manually).
    let proposal: unknown = null;
    let scan: TabularScan | null = null;
    try {
      const path = join(dir, row.storedFilename);
      let contentSample: string;
      if (isTabular(row.mime, row.name)) {
        try {
          scan = await scanTabular(path, row.mime, row.name);
          contentSample = scanSample(scan);
        } catch {
          // Corrupt tabular file: classify from raw text. buildSourcePack skips
          // csv/xlsx entirely, so a genuine tabular mime yields an empty pack
          // sample — fall back to the raw file bytes so the classifier sees more
          // than a bare filename.
          contentSample = await readContentSample(dir, row);
          if (!contentSample) contentSample = (await readFile(path)).toString("utf8").slice(0, 2000);
        }
      } else {
        contentSample = await readContentSample(dir, row);
      }
      proposal = await classifySource({ client, filename: row.name, contentSample, families });
      if (proposal && scan) {
        try {
          const key = (proposal as any).newFamily?.key ?? (proposal as any).familyKey;
          const names = tableNamesFor(key, scan.tables.map((t) => t.slug));
          const incoming = scan.tables.map((t) => ({ name: names[t.slug], columns: t.columns }));
          const existing = readWarehouseTables(id, key).map((t) => ({ name: t.name, columns: t.columns }));
          proposal = {
            ...(proposal as object),
            tables: scan.tables.map((t) => ({ name: names[t.slug], columns: t.columns.map((c) => c.name), rowCount: t.rowCount })),
            skippedFragments: scan.skipped.length,
            drift: computeDrift(existing, incoming),
          };
        } catch {
          // enrichment failure keeps the valid un-enriched proposal
        }
      }
    } catch {
      proposal = null;
    }
    db.sqlite
      .prepare("UPDATE sources SET proposal = ? WHERE id = ?")
      .run(proposal ? JSON.stringify(proposal) : null, row.id);
    updated.push({ id: row.id, proposal: proposal ?? null });
  }

  return Response.json({ sources: updated });
}
