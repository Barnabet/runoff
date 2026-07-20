import {
  BindingInventorySchema,
  type BindingInventory,
  type GoldenRow,
  type RunDocument,
  type RunoffDb,
} from "@runoff/core";
import { boundnessLine, buildScaffoldDigest, renderScaffoldDigest, type GoldenSummary } from "@runoff/engine";

const SELECT =
  "SELECT id, blueprint_id AS blueprintId, kind, run_id AS runId, section_key AS sectionKey, name, mime, stored_filename AS storedFilename, note, period, document, unify_error AS unifyError, bindings, created_at AS createdAt FROM goldens";

export function listGoldens(db: RunoffDb, blueprintId: string): GoldenRow[] {
  return db.sqlite.prepare(`${SELECT} WHERE blueprint_id = ? ORDER BY rowid DESC`).all(blueprintId) as GoldenRow[];
}

/** The shared SELECT by id — used by the pipeline and routes. */
export function getGoldenRow(db: RunoffDb, id: string): GoldenRow | null {
  return (db.sqlite.prepare(`${SELECT} WHERE id = ?`).get(id) as GoldenRow | undefined) ?? null;
}

const goldenLabel = (g: GoldenRow): string =>
  g.kind === "exemplar" ? (g.name ?? "exemplar") : `run ${g.runId}${g.kind === "section" ? ` §${g.sectionKey}` : ""}`;

/** Parse stored bindings JSON, degrading a corrupt/schema-drifted row to null. */
function parseBindings(bindings: string | null): BindingInventory | null {
  if (!bindings) return null;
  try {
    return BindingInventorySchema.parse(JSON.parse(bindings)) as BindingInventory;
  } catch {
    return null;
  }
}

export function listGoldenSummaries(db: RunoffDb, blueprintId: string): GoldenSummary[] {
  return listGoldens(db, blueprintId).map((g) => ({
    id: g.id,
    kind: g.kind,
    label: `${goldenLabel(g)} — ${boundnessLine(parseBindings(g.bindings))}`,
    note: g.note,
  }));
}

export interface ResolvedGolden {
  id: string;
  kind: "run" | "section" | "exemplar";
  label: string;
  note: string | null;
  period: string | null;
  document: RunDocument | null;
  inventory: BindingInventory | null;
  unifyError: string | null;
}

/** The single golden accessor (spec §8). document: null ⇒ the golden is inert to agents. */
export function resolveGolden(db: RunoffDb, goldenId: string): ResolvedGolden | null {
  const g = db.sqlite.prepare(`${SELECT} WHERE id = ?`).get(goldenId) as GoldenRow | undefined;
  if (!g) return null;
  // A corrupt/unparseable stored document degrades to not-unified (document:null),
  // so the golden resolves inert to agents rather than 500ing the copilot route.
  let document: RunDocument | null = null;
  try {
    if (g.kind === "exemplar") {
      document = g.document ? (JSON.parse(g.document) as RunDocument) : null;
    } else if (g.runId) {
      const row = db.sqlite.prepare("SELECT document FROM runs WHERE id = ?").get(g.runId) as
        | { document: string | null }
        | undefined;
      if (row?.document) {
        const doc = JSON.parse(row.document) as RunDocument;
        document = g.kind === "section" ? { ...doc, sections: doc.sections.filter((s) => s.key === g.sectionKey) } : doc;
        if (document.sections.length === 0) document = null;
      }
    }
  } catch {
    document = null;
  }
  // Corrupt/schema-drifted bindings on an otherwise-good document degrade to
  // null (renders "not yet bound") rather than throwing.
  const inventory = parseBindings(g.bindings);
  return {
    id: g.id,
    kind: g.kind as ResolvedGolden["kind"],
    label: goldenLabel(g),
    note: g.note,
    period: g.period,
    document,
    inventory,
    unifyError: g.unifyError,
  };
}

/** Scaffold digest (or inert explanation) for one resolved golden — the single construction the copilot route and tests share. */
export function scaffoldDigestFor(resolved: ResolvedGolden): string {
  if (!resolved.document) return `golden "${resolved.label}" is not unified (${resolved.unifyError ?? "not yet processed"})`;
  if (!resolved.inventory) return `golden "${resolved.label}" has no bindings — run Bind to data first`;
  return renderScaffoldDigest(buildScaffoldDigest({
    id: resolved.id, label: resolved.label, period: resolved.period,
    document: resolved.document, inventory: resolved.inventory,
  }));
}
