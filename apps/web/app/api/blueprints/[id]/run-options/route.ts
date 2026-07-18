import { getDb } from "../../../../../lib/db";
import { getRunOptions } from "../../../../../lib/runOptions";

// GET /api/blueprints/:id/run-options — the periods + presence checklist the
// RunDialog renders. 404 when the blueprint is missing.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const options = getRunOptions(getDb(), id);
  if (!options) return Response.json({ error: "blueprint not found" }, { status: 404 });
  return Response.json(options);
}
