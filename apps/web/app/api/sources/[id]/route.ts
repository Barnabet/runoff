import { rmSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

// DELETE /api/sources/:id — remove the source, its blueprint bindings, and
// (best-effort) the stored file.
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const row = db.sqlite
    .prepare("SELECT stored_filename AS storedFilename FROM sources WHERE id = ?")
    .get(id) as { storedFilename: string } | undefined;
  if (!row) return Response.json({ error: "source not found" }, { status: 404 });

  const tx = db.sqlite.transaction(() => {
    db.sqlite.prepare("DELETE FROM blueprint_sources WHERE source_id = ?").run(id);
    db.sqlite.prepare("DELETE FROM sources WHERE id = ?").run(id);
  });
  tx();

  try {
    rmSync(join(filesDir(), row.storedFilename), { force: true });
  } catch {
    // Stored file may already be gone; the row is what matters.
  }

  return Response.json({ ok: true });
}

// POST /api/sources/:id — acknowledge a refresh request for the source.
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const row = db.sqlite.prepare("SELECT id FROM sources WHERE id = ?").get(id) as { id: string } | undefined;
  if (!row) return Response.json({ error: "source not found" }, { status: 404 });

  return Response.json({ ok: true });
}
