import type { RunEvent } from "@runoff/core";
import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

interface RunRow {
  id: string;
  blueprintId: string;
  blueprintRev: number;
  triggerKind: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: string | null;
  document: string | null;
  createdAt: string;
}

// GET /api/runs/:id — the run row plus everything the Live Run UI needs in one
// round-trip: the full ordered event log, the run's flags, section metadata and
// source labels derived from the pinned revision, and the parent blueprint.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  const run = db.sqlite
    .prepare(
      `SELECT id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev,
              trigger_kind AS triggerKind, status, started_at AS startedAt,
              finished_at AS finishedAt, stats, document, created_at AS createdAt
       FROM runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });

  const events = (
    db.sqlite.prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as RunEvent);

  const flags = (
    db.sqlite
      .prepare(
        `SELECT id, run_id AS runId, code, section_key AS sectionKey, question,
                options, status, resolution, created_at AS createdAt
         FROM flags WHERE run_id = ? ORDER BY code, id`,
      )
      .all(id) as {
      id: string;
      runId: string;
      code: string;
      sectionKey: string;
      question: string;
      options: string;
      status: string;
      resolution: string | null;
      createdAt: string;
    }[]
  ).map((f) => ({
    ...f,
    options: JSON.parse(f.options) as string[],
    resolution: f.resolution ? (JSON.parse(f.resolution) as { option: string; note?: string }) : null,
  }));

  const blueprint = db.sqlite
    .prepare("SELECT id, name, client_name AS clientName FROM blueprints WHERE id = ?")
    .get(run.blueprintId) as { id: string; name: string; clientName: string } | undefined;

  // Section metadata comes from the revision the run is pinned to, not the
  // blueprint's current revision — the run drafted against that snapshot.
  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(run.blueprintId, run.blueprintRev) as { content: string } | undefined;
  const content = revRow ? (JSON.parse(revRow.content) as { sections: { key: string; number: number; heading: string }[] }) : null;
  const sectionMeta = content
    ? content.sections
        .map((s) => ({ key: s.key, number: s.number, heading: s.heading }))
        .sort((a, b) => a.number - b.number)
    : [];

  const sourceRows = db.sqlite
    .prepare(
      `SELECT s.id, s.name FROM blueprint_sources bs
       JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?`,
    )
    .all(run.blueprintId) as { id: string; name: string }[];
  const sourceLabels: Record<string, string> = Object.fromEntries(sourceRows.map((s) => [s.id, s.name]));

  return Response.json({ run, events, flags, sectionMeta, sourceLabels, blueprint });
}
