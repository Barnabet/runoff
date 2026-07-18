import { newId, type BlueprintContent } from "@runoff/core";
import { getDb } from "../../../lib/db";

interface BlueprintListRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  sourceCount: number;
}

// GET /api/blueprints — every blueprint with its bound-source count and the
// latest run (by created_at) plus that run's open-flag count.
export async function GET(): Promise<Response> {
  const db = getDb();
  const rows = db.sqlite
    .prepare(
      `SELECT b.id, b.name, b.client_name AS clientName, b.cadence_label AS cadenceLabel,
              b.status, b.current_rev AS currentRev,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.blueprint_id = b.id) AS sourceCount
       FROM blueprints b
       ORDER BY b.created_at DESC, b.id DESC`,
    )
    .all() as BlueprintListRow[];

  const lastRunStmt = db.sqlite.prepare(
    `SELECT id, finished_at AS finishedAt, status FROM runs
     WHERE blueprint_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const openFlagsStmt = db.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM flags WHERE run_id = ? AND status = 'open'",
  );

  const blueprints = rows.map((b) => {
    const run = lastRunStmt.get(b.id) as { id: string; finishedAt: string | null; status: string } | undefined;
    const lastRun = run
      ? { id: run.id, finishedAt: run.finishedAt, status: run.status, openFlags: (openFlagsStmt.get(run.id) as { n: number }).n }
      : null;
    return { ...b, lastRun };
  });

  return Response.json({ blueprints });
}

// POST /api/blueprints — create a blueprint plus revision 1 with a default,
// schema-valid BlueprintContent.
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  let body: { name?: unknown; clientName?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const clientName = typeof body.clientName === "string" ? body.clientName : "";

  const id = newId("bp");
  const content: BlueprintContent = {
    title: name,
    clientName,
    eyebrow: "",
    dateline: "",
    sections: [],
    globalRules: [],
    delivery: { recipient: "", autoDeliverOnClear: false },
  };

  const tx = db.sqlite.transaction(() => {
    db.sqlite
      .prepare("INSERT INTO blueprints (id, name, client_name, current_rev) VALUES (?, ?, ?, 1)")
      .run(id, name, clientName);
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
      .run(newId("rev"), id, JSON.stringify(content));
  });
  tx();

  return Response.json({ id });
}
