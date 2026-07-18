import { getDb } from "../../../../lib/db";
import { listProjectSources } from "../../../../lib/sourceManager";

type Ctx = { params: Promise<{ id: string }> };

interface BlueprintRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  createdAt: string;
  projectId: string;
}

// GET /api/blueprints/:id — the blueprint row, its current revision content
// (parsed), every family in the owning project (with filed periods), the ids of
// the families bound to this blueprint, and the project itself (for a back-link).
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const blueprint = db.sqlite
    .prepare(
      `SELECT id, name, client_name AS clientName, cadence_label AS cadenceLabel,
              status, current_rev AS currentRev, created_at AS createdAt,
              project_id AS projectId
       FROM blueprints WHERE id = ?`,
    )
    .get(id) as BlueprintRow | undefined;
  if (!blueprint) return Response.json({ error: "blueprint not found" }, { status: 404 });

  const projectRow = db.sqlite
    .prepare("SELECT id, name FROM projects WHERE id = ?")
    .get(blueprint.projectId) as { id: string; name: string } | undefined;
  const project = projectRow ?? { id: blueprint.projectId, name: "" };

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(id, blueprint.currentRev) as { content: string } | undefined;
  const content = revRow ? JSON.parse(revRow.content) : null;

  const { families } = listProjectSources(db, blueprint.projectId);
  const boundFamilyIds = (
    db.sqlite
      .prepare("SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?")
      .all(id) as { familyId: string }[]
  ).map((r) => r.familyId);

  return Response.json({ blueprint, content, project, families, boundFamilyIds });
}

// PATCH /api/blueprints/:id — update any of name/clientName/cadenceLabel/status
// and, when `familyIds` is present, replace the blueprint_families rows. Every
// bound family must belong to the blueprint's project, and all bound *periodic*
// families must share one granularity (a mixed set can't resolve a run period).
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const bp = db.sqlite
    .prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?")
    .get(id) as { projectId: string } | undefined;
  if (!bp) return Response.json({ error: "blueprint not found" }, { status: 404 });

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

  // Validate the family set BEFORE the write transaction: every id must exist
  // and belong to this blueprint's project, and the periodic granularities must
  // agree. Bad requests get a 400 with the rows left untouched.
  let familyIds: string[] | null = null;
  if (Array.isArray(body.familyIds)) {
    familyIds = body.familyIds.filter((f): f is string => typeof f === "string");
    const granularities = new Set<string>();
    for (const famId of familyIds) {
      const fam = db.sqlite
        .prepare("SELECT kind, granularity, project_id AS projectId FROM source_families WHERE id = ?")
        .get(famId) as { kind: string; granularity: string | null; projectId: string } | undefined;
      if (!fam || fam.projectId !== bp.projectId) {
        return Response.json({ error: "unknown family for this project" }, { status: 400 });
      }
      if (fam.kind === "periodic" && fam.granularity) granularities.add(fam.granularity);
    }
    if (granularities.size > 1) {
      return Response.json({ error: "granularity differs among bound periodic families" }, { status: 400 });
    }
  }

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
    if (familyIds) {
      db.sqlite.prepare("DELETE FROM blueprint_families WHERE blueprint_id = ?").run(id);
      const ins = db.sqlite.prepare(
        "INSERT OR IGNORE INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)",
      );
      for (const famId of familyIds) ins.run(id, famId);
    }
  });
  tx();

  return Response.json({ ok: true });
}
