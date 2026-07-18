import { newId, type BlueprintContent } from "@runoff/core";
import { applyEdit, type ProposedEdit } from "@runoff/engine";
import { getDb } from "../../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/notes/:id/accept — apply an agent note's proposed edit to its
// section, write a new blueprint revision, and resolve the note.
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const note = db.sqlite
    .prepare("SELECT blueprint_id AS blueprintId, section_key AS sectionKey, proposed_edit AS proposedEdit FROM notes WHERE id = ?")
    .get(id) as { blueprintId: string; sectionKey: string; proposedEdit: string | null } | undefined;
  if (!note) return Response.json({ error: "note not found" }, { status: 400 });
  if (!note.proposedEdit) return Response.json({ error: "note has no proposed edit" }, { status: 400 });
  const edit = JSON.parse(note.proposedEdit) as ProposedEdit;

  const bp = db.sqlite
    .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
    .get(note.blueprintId) as { currentRev: number } | undefined;
  if (!bp) return Response.json({ error: "blueprint not found" }, { status: 400 });

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(note.blueprintId, bp.currentRev) as { content: string } | undefined;
  if (!revRow) return Response.json({ error: "blueprint revision not found" }, { status: 400 });
  const content = JSON.parse(revRow.content) as BlueprintContent;

  const section = content.sections.find((s) => s.key === note.sectionKey);
  if (!section) {
    return Response.json({ error: `section "${note.sectionKey}" no longer exists` }, { status: 409 });
  }

  let newContent: BlueprintContent;
  try {
    const edited = applyEdit(section, edit);
    newContent = { ...content, sections: content.sections.map((s) => (s.key === note.sectionKey ? edited : s)) };
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }

  // Bump the revision and resolve the note atomically. Immediate mode takes the
  // write lock up front so the currentRev read and write cannot race.
  const tx = db.sqlite.transaction(() => {
    const cur = db.sqlite
      .prepare("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?")
      .get(note.blueprintId) as { currentRev: number };
    const rev = cur.currentRev + 1;
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, ?, ?)")
      .run(newId("rev"), note.blueprintId, rev, JSON.stringify(newContent));
    db.sqlite.prepare("UPDATE blueprints SET current_rev = ? WHERE id = ?").run(rev, note.blueprintId);
    db.sqlite.prepare("UPDATE notes SET status = 'resolved' WHERE id = ?").run(id);
    return rev;
  });
  const rev = tx.immediate();

  return Response.json({ rev });
}
