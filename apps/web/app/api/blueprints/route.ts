import { newId, type BlueprintContent } from "@runoff/core";
import { getDb } from "../../../lib/db";
import { listBlueprintsWithRuns } from "../../../lib/queries";

// GET /api/blueprints — every blueprint with its bound-source count and the
// latest run (by created_at) plus that run's open-flag count. The Library page
// server-renders the same join via `listBlueprintsWithRuns`.
export async function GET(): Promise<Response> {
  return Response.json({ blueprints: listBlueprintsWithRuns(getDb()) });
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
