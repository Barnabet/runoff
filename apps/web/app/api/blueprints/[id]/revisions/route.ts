import { newId, BlueprintContentSchema } from "@runoff/core";
import { getDb } from "../../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/blueprints/:id/revisions — validate the incoming BlueprintContent,
// insert it as the next revision, and bump the blueprint's currentRev.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const exists = db.sqlite.prepare("SELECT id FROM blueprints WHERE id = ?").get(id);
  if (!exists) return Response.json({ error: "blueprint not found" }, { status: 404 });

  let body: { content?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BlueprintContentSchema.safeParse(body?.content);
  if (!parsed.success) {
    return Response.json({ error: "invalid blueprint content", issues: parsed.error.issues }, { status: 400 });
  }

  // Read currentRev and write the bump in one immediate (write-locked) transaction
  // so concurrent saves cannot compute the same rev and collide on the UNIQUE index.
  const tx = db.sqlite.transaction(() => {
    const cur = db.sqlite
      .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
      .get(id) as { currentRev: number };
    const rev = cur.currentRev + 1;
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, ?, ?)")
      .run(newId("rev"), id, rev, JSON.stringify(parsed.data));
    db.sqlite.prepare("UPDATE blueprints SET current_rev = ? WHERE id = ?").run(rev, id);
    return rev;
  });
  const rev = tx.immediate();

  return Response.json({ rev });
}
