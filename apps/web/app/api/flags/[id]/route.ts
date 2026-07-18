import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/flags/:id — resolve a run flag with the chosen option (and optional
// note), then report how many flags remain open for the same run.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  let body: { option?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (typeof body.option !== "string") {
    return Response.json({ error: "option is required" }, { status: 400 });
  }

  const flag = db.sqlite
    .prepare("SELECT run_id AS runId FROM flags WHERE id = ?")
    .get(id) as { runId: string } | undefined;
  if (!flag) return Response.json({ error: "flag not found" }, { status: 404 });

  const resolution: { option: string; note?: string } = { option: body.option };
  if (typeof body.note === "string") resolution.note = body.note;

  db.sqlite
    .prepare("UPDATE flags SET resolution = ?, status = 'resolved' WHERE id = ?")
    .run(JSON.stringify(resolution), id);

  const { remainingOpen } = db.sqlite
    .prepare("SELECT COUNT(*) AS remainingOpen FROM flags WHERE run_id = ? AND status = 'open'")
    .get(flag.runId) as { remainingOpen: number };

  return Response.json({ remainingOpen });
}
