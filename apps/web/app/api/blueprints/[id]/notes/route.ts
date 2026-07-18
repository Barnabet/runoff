import { newId, type BlueprintContent } from "@runoff/core";
import { marginReply, type NoteTurn } from "@runoff/engine";
import { getDb } from "../../../../../lib/db";
import { getLlmClient } from "../../../../../lib/llm";

type Ctx = { params: Promise<{ id: string }> };

interface NoteRow {
  id: string;
  author: string;
  body: string;
  proposedEdit: string | null;
  status: string;
  createdAt: string;
}

// Notes are keyed on a random text id, so ORDER BY rowid (insertion order) is
// the reliable way to reconstruct a section's thread oldest-first.
const SELECT_NOTE =
  "SELECT id, author, body, proposed_edit AS proposedEdit, status, created_at AS createdAt FROM notes";

function shape(row: NoteRow) {
  return { ...row, proposedEdit: row.proposedEdit ? JSON.parse(row.proposedEdit) : null };
}

// GET /api/blueprints/:id/notes?sectionKey=… — the note thread for one section,
// oldest first.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const sectionKey = new URL(req.url).searchParams.get("sectionKey") ?? "";

  const rows = db.sqlite
    .prepare(`${SELECT_NOTE} WHERE blueprint_id = ? AND section_key = ? ORDER BY rowid`)
    .all(id, sectionKey) as NoteRow[];

  return Response.json({ notes: rows.map(shape) });
}

// POST /api/blueprints/:id/notes — record the user's note, ask the margin-notes
// agent for a reply against the current revision content, store its reply (with
// any proposed edit), and return it.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  let body: { sectionKey?: unknown; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const sectionKey = typeof body.sectionKey === "string" ? body.sectionKey : "";
  const noteBody = typeof body.body === "string" ? body.body : "";
  if (!sectionKey) return Response.json({ error: "sectionKey is required" }, { status: 400 });
  if (!noteBody) return Response.json({ error: "body is required" }, { status: 400 });

  const bp = db.sqlite
    .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
    .get(id) as { currentRev: number } | undefined;
  if (!bp) return Response.json({ error: "blueprint not found" }, { status: 404 });

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(id, bp.currentRev) as { content: string } | undefined;
  if (!revRow) return Response.json({ error: "blueprint revision not found" }, { status: 404 });
  const content = JSON.parse(revRow.content) as BlueprintContent;

  // Insert the user note first so the thread we hand the agent ends with it.
  db.sqlite
    .prepare("INSERT INTO notes (id, blueprint_id, section_key, author, body) VALUES (?, ?, ?, 'user', ?)")
    .run(newId("note"), id, sectionKey, noteBody);

  const thread: NoteTurn[] = (
    db.sqlite
      .prepare("SELECT author, body FROM notes WHERE blueprint_id = ? AND section_key = ? ORDER BY rowid")
      .all(id, sectionKey) as { author: NoteTurn["author"]; body: string }[]
  ).map((r) => ({ author: r.author, body: r.body }));

  let reply;
  try {
    reply = await marginReply({ client: getLlmClient(), content, sectionKey, thread });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const agentId = newId("note");
  db.sqlite
    .prepare("INSERT INTO notes (id, blueprint_id, section_key, author, body, proposed_edit) VALUES (?, ?, ?, 'agent', ?, ?)")
    .run(agentId, id, sectionKey, reply.reply, reply.proposedEdit ? JSON.stringify(reply.proposedEdit) : null);

  const agentNote = db.sqlite.prepare(`${SELECT_NOTE} WHERE id = ?`).get(agentId) as NoteRow;
  return Response.json({ agentNote: shape(agentNote) });
}
