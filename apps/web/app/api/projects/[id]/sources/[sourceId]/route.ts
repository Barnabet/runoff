import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Granularity } from "@runoff/core";
import { getDb } from "../../../../../../lib/db";
import { fileSource } from "../../../../../../lib/sourceManager";

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

  const result = fileSource(db, {
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
    .prepare("SELECT status, stored_filename AS storedFilename FROM sources WHERE id = ? AND project_id = ?")
    .get(sourceId, id) as { status: string; storedFilename: string } | undefined;
  if (!row) return Response.json({ error: "source not found" }, { status: 404 });
  if (row.status === "replaced") return Response.json({ error: "replaced sources cannot be deleted" }, { status: 400 });

  db.sqlite.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);

  try {
    rmSync(join(filesDir(), row.storedFilename), { force: true });
  } catch {
    // Stored file may already be gone; the row removal is what matters.
  }

  return Response.json({ ok: true });
}
