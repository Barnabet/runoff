import { getDb } from "../../../../../lib/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  // Both scopes: this blueprint's own rows plus the project-scoped rows of its
  // project, so the builder drawer can badge each memory's scope.
  const rows = getDb()
    .sqlite.prepare(
      `SELECT id, scope, project_id AS projectId, blueprint_id AS blueprintId, body, source,
              origin_id AS originId, status, created_at AS createdAt
       FROM memories
       WHERE blueprint_id = ? OR (scope='project' AND project_id = (SELECT project_id FROM blueprints WHERE id = ?))
       ORDER BY rowid DESC`,
    )
    .all(id, id);
  return Response.json({ memories: rows });
}
