import { newId } from "@runoff/core";
import { getDb } from "../../../lib/db";
import { getRunOptions } from "../../../lib/runOptions";

// POST /api/runs — enqueue a run for a blueprint, pinned to its current
// revision and (for periodic blueprints) a chosen period. The worker picks up
// `queued` runs. 404 if the blueprint is missing; 400 if the period is not one
// the blueprint can run.
export async function POST(req: Request): Promise<Response> {
  const db = getDb();

  let body: { blueprintId?: unknown; period?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const blueprintId = typeof body.blueprintId === "string" ? body.blueprintId : "";
  const period = typeof body.period === "string" ? body.period : null;

  const bp = db.sqlite
    .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
    .get(blueprintId) as { currentRev: number } | undefined;
  if (!bp) return Response.json({ error: "blueprint not found" }, { status: 404 });

  // A periodic blueprint must run a filed period; a constants-only one must not
  // carry a period. `getRunOptions` returns non-null here (blueprint exists).
  const options = getRunOptions(db, blueprintId)!;
  const valid =
    options.granularity === null
      ? period === null
      : period !== null && options.periods.some((p) => p.period === period);
  if (!valid) {
    return Response.json({ error: "period not available for this blueprint" }, { status: 400 });
  }

  const id = newId("run");
  db.sqlite
    .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period) VALUES (?, ?, ?, 'queued', ?)")
    .run(id, blueprintId, bp.currentRev, period);

  return Response.json({ id });
}
