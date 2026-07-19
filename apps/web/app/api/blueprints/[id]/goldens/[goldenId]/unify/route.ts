import { getDb } from "../../../../../../../lib/db";
import { getGoldenRow } from "../../../../../../../lib/goldens";
import { unifyAndBindExemplar } from "../../../../../../../lib/goldenPipeline";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; goldenId: string }> }): Promise<Response> {
  const db = getDb();
  const { id, goldenId } = await ctx.params;
  const row = db.sqlite.prepare("SELECT blueprint_id AS b, kind FROM goldens WHERE id = ?").get(goldenId) as
    | { b: string; kind: string }
    | undefined;
  if (!row || row.b !== id) return Response.json({ error: "golden not found" }, { status: 404 });
  if (row.kind !== "exemplar") return Response.json({ error: "only exemplar goldens can be unified" }, { status: 400 });
  await unifyAndBindExemplar({ db, goldenId });
  return Response.json({ golden: getGoldenRow(db, goldenId) });
}
