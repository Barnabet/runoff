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

// POST /api/sources/:id — mark the source as refreshed (updates refreshed_at).
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const res = db.sqlite.prepare("UPDATE sources SET refreshed_at = datetime('now') WHERE id = ?").run(id);
  if (res.changes === 0) return Response.json({ error: "source not found" }, { status: 404 });

  const row = db.sqlite
    .prepare("SELECT refreshed_at AS refreshedAt FROM sources WHERE id = ?")
    .get(id) as { refreshedAt: string };
  return Response.json({ ok: true, refreshedAt: row.refreshedAt });
}
