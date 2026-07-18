import { newId } from "@runoff/core";
import { getDb } from "../../../lib/db";

// POST /api/runs — enqueue a run for a blueprint, pinned to its current
// revision. The worker picks up `queued` runs. 404 if the blueprint is missing.
export async function POST(req: Request): Promise<Response> {
  const db = getDb();

  let body: { blueprintId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const blueprintId = typeof body.blueprintId === "string" ? body.blueprintId : "";
  const bp = db.sqlite
    .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
    .get(blueprintId) as { currentRev: number } | undefined;
  if (!bp) return Response.json({ error: "blueprint not found" }, { status: 404 });

  const id = newId("run");
  db.sqlite
    .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, ?, ?, 'queued')")
    .run(id, blueprintId, bp.currentRev);

  return Response.json({ id });
}
