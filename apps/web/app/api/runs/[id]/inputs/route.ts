import { getDb } from "../../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

const KINDS = new Set(["pause", "resume", "steer", "answer"]);

// POST /api/runs/:id/inputs — queue an out-of-band input for the running run
// (pause/resume/steer/answer). The worker consumes unconsumed rows in order.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  let body: { kind?: unknown; text?: unknown; questionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const kind = body.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    return Response.json({ error: "kind must be one of pause|resume|steer|answer" }, { status: 400 });
  }

  const run = db.sqlite.prepare("SELECT id FROM runs WHERE id = ?").get(id);
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });

  const payload: { text?: string; questionId?: string } = {};
  if (typeof body.text === "string") payload.text = body.text;
  if (typeof body.questionId === "string") payload.questionId = body.questionId;

  db.sqlite
    .prepare("INSERT INTO run_inputs (run_id, kind, payload) VALUES (?, ?, ?)")
    .run(id, kind, JSON.stringify(payload));

  return Response.json({ ok: true });
}
