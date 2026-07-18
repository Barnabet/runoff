import { notFound } from "next/navigation";
import type { BlueprintContent } from "@runoff/core";
import type { ProposedEdit } from "@runoff/engine";
import { Builder } from "@/components/builder/Builder";
import { getDb } from "@/lib/db";
import { listSourcesWithUsage } from "@/lib/queries";
import type { NoteRow, SourceRow } from "@/lib/api";

// The builder reads the live current revision, bound sources, and the opening
// section's note thread on every request; a save or an accepted edit must show
// on reload without a rebuild.
export const dynamic = "force-dynamic";

interface BlueprintRow {
  id: string;
  name: string;
  clientName: string;
  status: string;
  currentRev: number;
}

interface NoteDbRow {
  id: string;
  author: "user" | "agent";
  body: string;
  proposedEdit: string | null;
  status: string;
  createdAt: string;
}

function shapeNote(row: NoteDbRow): NoteRow {
  return {
    ...row,
    proposedEdit: row.proposedEdit ? (JSON.parse(row.proposedEdit) as ProposedEdit) : null,
  };
}

export default async function BlueprintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const blueprint = db.sqlite
    .prepare(
      `SELECT id, name, client_name AS clientName, status, current_rev AS currentRev
       FROM blueprints WHERE id = ?`,
    )
    .get(id) as BlueprintRow | undefined;
  if (!blueprint) notFound();

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(id, blueprint.currentRev) as { content: string } | undefined;
  if (!revRow) notFound();
  const content = JSON.parse(revRow.content) as BlueprintContent;

  const boundSources = db.sqlite
    .prepare(
      `SELECT s.id FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?`,
    )
    .all(id) as { id: string }[];
  const allSources = listSourcesWithUsage(db) as SourceRow[];

  const initialSectionKey = content.sections[0]?.key ?? "";
  const initialNotes = initialSectionKey
    ? (
        db.sqlite
          .prepare(
            `SELECT id, author, body, proposed_edit AS proposedEdit, status, created_at AS createdAt
             FROM notes WHERE blueprint_id = ? AND section_key = ? ORDER BY rowid`,
          )
          .all(id, initialSectionKey) as NoteDbRow[]
      ).map(shapeNote)
    : [];

  return (
    <Builder
      blueprintId={blueprint.id}
      name={blueprint.name}
      clientName={blueprint.clientName}
      initialStatus={blueprint.status}
      initialRev={blueprint.currentRev}
      initialContent={content}
      allSources={allSources}
      initialBoundIds={boundSources.map((s) => s.id)}
      initialSectionKey={initialSectionKey}
      initialNotes={initialNotes}
    />
  );
}
