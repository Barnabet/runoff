import { rmSync } from "node:fs";
import { join } from "node:path";
import { attachWarehouse, detachWarehouse, whFamilyTables, deleteRows, type Granularity } from "@runoff/core";
import { getDb } from "../../../../../../lib/db";
import { fileSource, withIngestLock } from "../../../../../../lib/sourceManager";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

interface RefileBody {
  familyId?: string;
  newFamily?: { key: string; label: string; kind: "periodic" | "constant"; granularity: Granularity | null };
  period: string | null;
}

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

// PATCH /api/projects/:id/sources/:sourceId — refile a source into a (possibly
// new) family slot. Same body + rules as confirm.
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id, sourceId } = await ctx.params;

  let body: Partial<RefileBody>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = await fileSource(db, {
    projectId: id,
    sourceId,
    familyId: body.familyId,
    newFamily: body.newFamily,
    period: body.period ?? null,
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}

// DELETE /api/projects/:id/sources/:sourceId — remove an unfiled or filed
// source and its stored file. `replaced` rows are kept (400) to preserve the
// provenance of any run that used them.
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id, sourceId } = await ctx.params;

  const row = db.sqlite
    .prepare("SELECT status, family_id AS familyId, period, stored_filename AS storedFilename FROM sources WHERE id = ? AND project_id = ?")
    .get(sourceId, id) as { status: string; familyId: string | null; period: string | null; storedFilename: string } | undefined;
  if (!row) return Response.json({ error: "source not found" }, { status: 404 });
  if (row.status === "replaced") return Response.json({ error: "replaced sources cannot be deleted" }, { status: 400 });

  // The mutation (row removal + warehouse cleanup + stored-file unlink)
  // serializes on the shared ingest lock: no DELETE can land inside an ingest's
  // `await readTabular` gap, and its ATTACH can't collide with the ingest's.
  // The SELECT/validation above stays outside. Row removal precedes warehouse
  // cleanup — no transaction needed across them: worst case on crash is orphan
  // warehouse rows, which the next re-file of the slot clears.
  await withIngestLock(async () => {
    db.sqlite.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);

    if (row.status === "filed" && row.familyId) {
      const fam = db.sqlite
        .prepare("SELECT key, kind FROM source_families WHERE id = ?")
        .get(row.familyId) as { key: string; kind: "periodic" | "constant" } | undefined;
      if (fam) {
        attachWarehouse(db.sqlite, id);
        try {
          const tables = whFamilyTables(db.sqlite, fam.key).map((t) => t.name);
          deleteRows(db.sqlite, tables, fam.kind === "periodic" ? row.period : null);
        } finally {
          detachWarehouse(db.sqlite);
        }
      }
    }

    try {
      rmSync(join(filesDir(), row.storedFilename), { force: true });
    } catch {
      // Stored file may already be gone; the row removal is what matters.
    }
  });

  return Response.json({ ok: true });
}
