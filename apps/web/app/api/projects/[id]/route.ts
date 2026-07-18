import { getDb } from "../../../../lib/db";
import { getProjectPayload } from "../../../../lib/queries";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/projects/:id — the project header row plus its scoped blueprint
// ledger. 404 when the project row is missing.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const payload = getProjectPayload(getDb(), id);
  if (!payload) return Response.json({ error: "project not found" }, { status: 404 });
  return Response.json(payload);
}

// PATCH /api/projects/:id — rename the project. Name is required (trimmed).
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const exists = db.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!exists) return Response.json({ error: "project not found" }, { status: 404 });

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  db.sqlite.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
  return Response.json({ ok: true });
}
