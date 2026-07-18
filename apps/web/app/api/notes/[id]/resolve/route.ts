import { getDb } from "../../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/notes/:id/resolve — mark an agent note resolved WITHOUT applying its
// proposed edit (the "Dismiss" action in the margin). Contrast with
// /accept, which applies the edit and bumps a revision.
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const note = db.sqlite.prepare("SELECT id FROM notes WHERE id = ?").get(id);
  if (!note) return Response.json({ error: "note not found" }, { status: 400 });

  db.sqlite.prepare("UPDATE notes SET status = 'resolved' WHERE id = ?").run(id);
  return Response.json({ ok: true });
}
