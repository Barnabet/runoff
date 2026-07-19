import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { newId } from "@runoff/core";
import { getDb } from "../../../../../lib/db";
import { listProjectSources } from "../../../../../lib/sourceManager";

type Ctx = { params: Promise<{ id: string }> };

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// Strip any path components and reduce to a filesystem-safe basename.
function sanitizeName(name: string): string {
  const safe = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "file";
}

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// GET /api/projects/:id/sources — the project's families + unfiled uploads.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const project = db.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return Response.json({ error: "project not found" }, { status: 404 });
  return Response.json(listProjectSources(db, id));
}

// POST /api/projects/:id/sources — multipart upload of one or more files under
// the `files` key. Each becomes an `unfiled` source row; bytes land under
// RUNOFF_FILES_DIR/<id>_<sanitized-origname>.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const project = db.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return Response.json({ error: "project not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "files are required" }, { status: 400 });

  // Validate every file's size before any byte is written or row inserted.
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "file exceeds 100MB limit" }, { status: 413 });
    }
  }

  const dir = filesDir();
  mkdirSync(dir, { recursive: true });

  const insert = db.sqlite.prepare(
    "INSERT INTO sources (id, project_id, name, kind, stored_filename, mime, size, status) VALUES (?, ?, ?, 'file', ?, ?, ?, 'unfiled')",
  );
  const inserted: { id: string; name: string; storedFilename: string; mime: string; size: number; status: string }[] = [];

  for (const file of files) {
    const sourceId = newId("src");
    const safe = sanitizeName(file.name);
    const storedFilename = `${sourceId}_${safe}`;
    const buf = Buffer.from(await file.arrayBuffer());
    // Multipart defaults a typeless part to application/octet-stream; treat that
    // as "unknown" and prefer an extension-derived mime when we can.
    const declared = file.type && file.type !== "application/octet-stream" ? file.type : "";
    const mime = declared || EXT_MIME[extname(safe).toLowerCase()] || "application/octet-stream";

    writeFileSync(join(dir, storedFilename), buf);
    insert.run(sourceId, id, file.name, storedFilename, mime, buf.length);
    inserted.push({ id: sourceId, name: file.name, storedFilename, mime, size: buf.length, status: "unfiled" });
  }

  return Response.json({ sources: inserted });
}
