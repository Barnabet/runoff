import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { newId } from "@runoff/core";
import { getDb } from "../../../lib/db";

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

// GET /api/sources — every source with a count of blueprints referencing it.
export async function GET(): Promise<Response> {
  const db = getDb();
  const sources = db.sqlite
    .prepare(
      `SELECT s.id, s.name, s.kind, s.stored_filename AS storedFilename, s.mime, s.size,
              s.uploaded_at AS uploadedAt, s.refreshed_at AS refreshedAt,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.source_id = s.id) AS usedBy
       FROM sources s
       ORDER BY s.uploaded_at DESC, s.id DESC`,
    )
    .all();
  return Response.json({ sources });
}

// POST /api/sources — multipart upload (`file`, `name`). Stores the bytes under
// data/files/<id>_<sanitized-origname> and records the source row.
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
  const nameField = form.get("name");
  const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;

  const id = newId("src");
  const safe = sanitizeName(file.name);
  const storedFilename = `${id}_${safe}`;
  const buf = Buffer.from(await file.arrayBuffer());
  // Multipart encoding defaults a typeless part to application/octet-stream, so
  // treat that as "unknown" and prefer an extension-derived mime when we can.
  const declared = file.type && file.type !== "application/octet-stream" ? file.type : "";
  const mime = declared || EXT_MIME[extname(safe).toLowerCase()] || "application/octet-stream";

  const dir = filesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, storedFilename), buf);

  db.sqlite
    .prepare("INSERT INTO sources (id, name, kind, stored_filename, mime, size) VALUES (?, ?, 'file', ?, ?, ?)")
    .run(id, name, storedFilename, mime, buf.length);

  return Response.json({ id });
}
