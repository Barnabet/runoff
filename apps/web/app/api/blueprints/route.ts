import { newId, type BlueprintContent } from "@runoff/core";
import { getDb } from "../../../lib/db";
import { listBlueprintsWithRuns } from "../../../lib/queries";

// GET /api/blueprints?projectId=… — every blueprint in one project with its
// bound-source count and the latest run (by created_at) plus that run's
// open-flag count. The project page server-renders the same scoped join.
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  return Response.json({ blueprints: listBlueprintsWithRuns(getDb(), projectId) });
}

// POST /api/blueprints — create a blueprint (scoped to a project) plus revision
// 1 with a default, schema-valid BlueprintContent.
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  let body: { name?: unknown; clientName?: unknown; projectId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const clientName = typeof body.clientName === "string" ? body.clientName : "";

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  const project = db.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) return Response.json({ error: "unknown projectId" }, { status: 400 });

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
      .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, ?, ?, ?, 1)")
      .run(id, name, clientName, projectId);
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
      .run(newId("rev"), id, JSON.stringify(content));
  });
  tx();

  return Response.json({ id });
}
