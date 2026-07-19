import { join } from "node:path";
import type { Granularity } from "@runoff/core";
import { ParsePlanSchema } from "@runoff/core";
import { isTabular, scanTabular } from "@runoff/engine";
import { getDb } from "../../../../../../../lib/db";
import { getLlmClient } from "../../../../../../../lib/llm";
import { planForUpload } from "../../../../../../../lib/planPropose";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

// POST /api/projects/:id/sources/:sourceId/replan — body { feedback }. Revises
// the current plan proposal with user feedback; the prior proposal is only
// replaced on success.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id, sourceId } = await ctx.params;
  let body: { feedback?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  if (typeof body.feedback !== "string" || !body.feedback.trim())
    return Response.json({ error: "feedback is required" }, { status: 400 });

  const row = db.sqlite
    .prepare("SELECT id, name, mime, stored_filename AS storedFilename, proposal FROM sources WHERE id = ? AND project_id = ? AND status = 'unfiled'")
    .get(sourceId, id) as { id: string; name: string; mime: string; storedFilename: string; proposal: string | null } | undefined;
  if (!row) return Response.json({ error: "source not found" }, { status: 404 });
  const proposal = row.proposal ? JSON.parse(row.proposal) : null;
  if (!proposal || !isTabular(row.mime, row.name)) return Response.json({ error: "source has no plan proposal" }, { status: 400 });

  try {
    const path = join(process.env.RUNOFF_FILES_DIR ?? "data/files", row.storedFilename);
    const scan = await scanTabular(path, row.mime, row.name);
    const famRow = db.sqlite
      .prepare("SELECT granularity FROM source_families WHERE project_id = ? AND key = ?")
      .get(id, proposal.newFamily?.key ?? proposal.familyKey) as { granularity: Granularity | null } | undefined;
    const outcome = await planForUpload({
      client: getLlmClient(), filename: row.name, path, mime: row.mime, scan,
      storedPlan: proposal.plan ? ParsePlanSchema.parse(proposal.plan) : null,
      slotPeriod: proposal.period ?? null,
      granularity: famRow?.granularity ?? proposal.newFamily?.granularity ?? null,
      feedback: body.feedback,
    });
    if (outcome.planStatus === "none") return Response.json({ error: "replan failed: no plan produced" }, { status: 500 });
    const updated = { ...proposal, plan: outcome.plan, planStatus: outcome.planStatus, preview: outcome.preview, report: outcome.report };
    db.sqlite.prepare("UPDATE sources SET proposal = ? WHERE id = ?").run(JSON.stringify(updated), row.id);
    return Response.json({ proposal: updated });
  } catch (err) {
    return Response.json({ error: `replan failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
