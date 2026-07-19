import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { newId } from "@runoff/core";
import { getDb } from "../../../../../lib/db";
import { listGoldens } from "../../../../../lib/goldens";
import { rebuildRunGoldenInventory, unifyAndBindExemplar } from "../../../../../lib/goldenPipeline";

type Ctx = { params: Promise<{ id: string }> };

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const sanitizeName = (name: string) => basename(name).replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
const filesDir = () => process.env.RUNOFF_FILES_DIR ?? "data/files";

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return Response.json({ goldens: listGoldens(getDb(), id) });
}

// POST — JSON {kind:'run'|'section', runId, sectionKey?, note?} to star, or
// multipart (`file`, optional `name`, `note`) to upload an exemplar.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
    const nameField = form.get("name");
    const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;
    const noteField = form.get("note");
    const note = typeof noteField === "string" && noteField.trim() ? noteField.trim() : null;

    const goldenId = newId("gold");
    const safe = sanitizeName(file.name);
    const storedFilename = `${goldenId}_${safe}`;
    const declared = file.type && file.type !== "application/octet-stream" ? file.type : "";
    const mime = declared || EXT_MIME[extname(safe).toLowerCase()] || "application/octet-stream";
    mkdirSync(filesDir(), { recursive: true });
    writeFileSync(join(filesDir(), storedFilename), Buffer.from(await file.arrayBuffer()));
    db.sqlite
      .prepare("INSERT INTO goldens (id, blueprint_id, kind, name, mime, stored_filename, note) VALUES (?, ?, 'exemplar', ?, ?, ?, ?)")
      .run(goldenId, id, name, mime, storedFilename, note);
    await unifyAndBindExemplar({ db, goldenId }); // errors are persisted (unify_error), never thrown
    return Response.json({ id: goldenId });
  }

  let body: { kind?: unknown; runId?: unknown; sectionKey?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const kind = body.kind === "run" || body.kind === "section" ? body.kind : null;
  const runId = typeof body.runId === "string" ? body.runId : "";
  const sectionKey = typeof body.sectionKey === "string" ? body.sectionKey : null;
  if (!kind || !runId) return Response.json({ error: "kind ('run'|'section') and runId are required" }, { status: 400 });
  if (kind === "section" && !sectionKey) return Response.json({ error: "sectionKey is required for kind 'section'" }, { status: 400 });

  const run = db.sqlite.prepare("SELECT blueprint_id AS blueprintId FROM runs WHERE id = ?").get(runId) as
    | { blueprintId: string }
    | undefined;
  if (!run || run.blueprintId !== id) return Response.json({ error: "run not found for this blueprint" }, { status: 404 });

  const goldenId = newId("gold");
  db.sqlite
    .prepare("INSERT INTO goldens (id, blueprint_id, kind, run_id, section_key, note) VALUES (?, ?, ?, ?, ?, ?)")
    .run(goldenId, id, kind, runId, sectionKey, typeof body.note === "string" ? body.note : null);
  // Copy the run's period onto the golden so resolveGolden needs no join, then
  // build the deterministic §4 inventory from the run document's citations.
  db.sqlite
    .prepare("UPDATE goldens SET period = (SELECT period FROM runs WHERE id = ?) WHERE id = ?")
    .run(runId, goldenId);
  rebuildRunGoldenInventory({ db, goldenId });
  return Response.json({ id: goldenId });
}
