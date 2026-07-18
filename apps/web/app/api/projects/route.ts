import { newId } from "@runoff/core";
import { getDb } from "../../../lib/db";
import { listProjects } from "../../../lib/queries";

// GET /api/projects — every project with its blueprint count and most recent
// activity. The home page server-renders the same list via `listProjects`.
export async function GET(): Promise<Response> {
  return Response.json({ projects: listProjects(getDb()) });
}

// POST /api/projects — create a project. Name is required (trimmed).
export async function POST(req: Request): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  const id = newId("proj");
  getDb().sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
  return Response.json({ id });
}
