import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../../../lib/db";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const row = db.sqlite.prepare("SELECT stored_filename AS storedFilename FROM goldens WHERE id = ?").get(id) as
    | { storedFilename: string | null }
    | undefined;
  if (!row) return Response.json({ error: "golden not found" }, { status: 404 });
  db.sqlite.prepare("DELETE FROM goldens WHERE id = ?").run(id);
  if (row.storedFilename) {
    try {
      unlinkSync(join(process.env.RUNOFF_FILES_DIR ?? "data/files", row.storedFilename));
    } catch {
      // best-effort: a missing file must not fail the delete
    }
  }
  return Response.json({ ok: true });
}
