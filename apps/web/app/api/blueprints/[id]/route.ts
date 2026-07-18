import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

interface BlueprintRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  createdAt: string;
}

// GET /api/blueprints/:id — the blueprint row, its current revision content
// (parsed), and the sources bound to it.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const blueprint = db.sqlite
    .prepare(
      `SELECT id, name, client_name AS clientName, cadence_label AS cadenceLabel,
              status, current_rev AS currentRev, created_at AS createdAt
       FROM blueprints WHERE id = ?`,
    )
    .get(id) as BlueprintRow | undefined;
  if (!blueprint) return Response.json({ error: "blueprint not found" }, { status: 404 });

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(id, blueprint.currentRev) as { content: string } | undefined;
  const content = revRow ? JSON.parse(revRow.content) : null;

  const sources = db.sqlite
    .prepare(
      `SELECT s.id, s.name, s.kind, s.stored_filename AS storedFilename, s.mime, s.size,
              s.uploaded_at AS uploadedAt, s.refreshed_at AS refreshedAt
       FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?
       ORDER BY s.uploaded_at DESC, s.id DESC`,
    )
    .all(id);

  return Response.json({ blueprint, content, sources });
}

// PATCH /api/blueprints/:id — update any of name/clientName/cadenceLabel/status
// and, when `sourceIds` is present, replace the blueprint_sources rows.
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const exists = db.sqlite.prepare("SELECT id FROM blueprints WHERE id = ?").get(id);
  if (!exists) return Response.json({ error: "blueprint not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const columns: Record<string, string> = {
    name: "name",
    clientName: "client_name",
    cadenceLabel: "cadence_label",
    status: "status",
  };

  const tx = db.sqlite.transaction(() => {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (typeof body[key] === "string") {
        sets.push(`${column} = ?`);
        values.push(body[key]);
      }
    }
    if (sets.length) {
      db.sqlite.prepare(`UPDATE blueprints SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    if (Array.isArray(body.sourceIds)) {
      db.sqlite.prepare("DELETE FROM blueprint_sources WHERE blueprint_id = ?").run(id);
      const ins = db.sqlite.prepare(
        "INSERT OR IGNORE INTO blueprint_sources (blueprint_id, source_id) VALUES (?, ?)",
      );
      for (const sid of body.sourceIds) {
        if (typeof sid === "string") ins.run(id, sid);
      }
    }
  });
  tx();

  return Response.json({ ok: true });
}
