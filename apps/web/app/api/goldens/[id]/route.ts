import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { PERIOD_REGEX } from "@runoff/core";
import { getDb } from "../../../../lib/db";
import { getGoldenRow } from "../../../../lib/goldens";
import { rebuildRunGoldenInventory, verifyStoredInventory } from "../../../../lib/goldenPipeline";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const { period } = (await req.json()) as { period: string | null };
  if (period !== null && !Object.values(PERIOD_REGEX).some((re) => re.test(period)))
    return Response.json({ error: `invalid period: ${period}` }, { status: 400 });
  const row = db.sqlite.prepare("SELECT kind FROM goldens WHERE id = ?").get(id) as { kind: string } | undefined;
  if (!row) return Response.json({ error: "golden not found" }, { status: 404 });
  db.sqlite.prepare("UPDATE goldens SET period = ? WHERE id = ?").run(period, id);
  if (row.kind === "exemplar") verifyStoredInventory({ db, goldenId: id });
  else rebuildRunGoldenInventory({ db, goldenId: id });
  return Response.json({ golden: getGoldenRow(db, id) });
}

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
