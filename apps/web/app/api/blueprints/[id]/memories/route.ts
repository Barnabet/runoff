import { getDb } from "../../../../../lib/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rows = getDb()
    .sqlite.prepare(
      "SELECT id, blueprint_id AS blueprintId, body, source, origin_id AS originId, status, created_at AS createdAt FROM memories WHERE blueprint_id = ? ORDER BY rowid DESC",
    )
    .all(id);
  return Response.json({ memories: rows });
}
