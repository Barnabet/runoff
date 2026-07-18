import { getDb } from "../../../../lib/db";
import { getRunPayload } from "../../../../lib/queries";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/runs/:id — the run row plus everything the Live Run UI needs in one
// round-trip: the full ordered event log, the run's flags, section metadata,
// masthead, and source labels from the pinned revision, and the parent
// blueprint. The heavy lifting lives in `getRunPayload` so the server-rendered
// run page and this route read from exactly one query.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const payload = getRunPayload(getDb(), id);
  if (!payload) return Response.json({ error: "run not found" }, { status: 404 });
  return Response.json(payload);
}
