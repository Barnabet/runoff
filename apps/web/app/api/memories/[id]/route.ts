import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.status !== "active" && body.status !== "disabled") {
    return Response.json({ error: "status must be 'active' or 'disabled'" }, { status: 400 });
  }
  const res = db.sqlite.prepare("UPDATE memories SET status = ? WHERE id = ?").run(body.status, id);
  if (res.changes === 0) return Response.json({ error: "memory not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const res = getDb().sqlite.prepare("DELETE FROM memories WHERE id = ?").run((await ctx.params).id);
  if (res.changes === 0) return Response.json({ error: "memory not found" }, { status: 404 });
  return Response.json({ ok: true });
}
