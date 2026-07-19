import { getDb } from "../../../../../../../lib/db";
import { getGoldenRow } from "../../../../../../../lib/goldens";
import { bindExemplar, rebuildRunGoldenInventory, verifyStoredInventory } from "../../../../../../../lib/goldenPipeline";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; goldenId: string }> }): Promise<Response> {
  const db = getDb();
  const { id, goldenId } = await ctx.params;
  const row = db.sqlite.prepare("SELECT blueprint_id AS b, kind, document, bindings FROM goldens WHERE id = ?").get(goldenId) as
    | { b: string; kind: string; document: string | null; bindings: string | null }
    | undefined;
  if (!row || row.b !== id) return Response.json({ error: "golden not found" }, { status: 404 });
  let feedback: string | undefined;
  try {
    feedback = ((await req.json()) as { feedback?: string }).feedback || undefined;
  } catch {
    feedback = undefined;
  }

  if (row.kind !== "exemplar") {
    if (feedback) return Response.json({ error: "feedback requires an exemplar golden" }, { status: 400 });
    rebuildRunGoldenInventory({ db, goldenId });
  } else if (!row.document) {
    return Response.json({ error: "golden is not unified" }, { status: 400 });
  } else if (row.bindings && !feedback) {
    verifyStoredInventory({ db, goldenId });
  } else {
    const r = await bindExemplar({ db, goldenId, feedback });
    if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
  }
  return Response.json({ golden: getGoldenRow(db, goldenId) });
}
