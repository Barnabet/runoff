import type { Granularity } from "@runoff/core";
import { getDb } from "../../../../../../lib/db";
import { fileSource } from "../../../../../../lib/sourceManager";

type Ctx = { params: Promise<{ id: string }> };

export interface ConfirmBody {
  sourceId: string;
  familyId?: string;
  newFamily?: { key: string; label: string; kind: "periodic" | "constant"; granularity: Granularity | null };
  period: string | null;
  periodMismatch?: "keep" | "exclude";
}

// POST /api/projects/:id/sources/confirm — file an unfiled source into a family
// slot (creating the family when `newFamily` is given). Delegates the slot rules
// to fileSource.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  let body: Partial<ConfirmBody>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.sourceId !== "string") return Response.json({ error: "sourceId is required" }, { status: 400 });
  // Guard the period-mismatch override: only "keep"/"exclude" may reach the plan,
  // so a non-UI client can't persist a schema-invalid onPeriodMismatch.
  if (body.periodMismatch !== undefined && body.periodMismatch !== "keep" && body.periodMismatch !== "exclude") {
    return Response.json({ error: "periodMismatch must be \"keep\" or \"exclude\"" }, { status: 400 });
  }

  const result = await fileSource(db, {
    projectId: id,
    sourceId: body.sourceId,
    familyId: body.familyId,
    newFamily: body.newFamily,
    period: body.period ?? null,
    periodMismatch: body.periodMismatch,
  });
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
