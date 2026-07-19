import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BindingInventory, RunDocument, SubmittedInventory } from "@runoff/core";

import { freshDb, jsonReq, ctx } from "./helpers";
import { getDb } from "../lib/db";
import { fileSource } from "../lib/sourceManager";

// Mock only the engine's LLM entry points (unify + bind). Verification,
// inventoryFromCitations, and renderGoldenForPrompt stay real so the pipeline
// runs real SQL against the test warehouse.
const { unifyMock, bindMock } = vi.hoisted(() => ({ unifyMock: vi.fn(), bindMock: vi.fn() }));
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@runoff/engine")>()),
  unifyGoldenReport: (...a: unknown[]) => unifyMock(...a),
  bindGolden: (...a: unknown[]) => bindMock(...a),
}));
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

const { renderGoldenForPrompt } = await import("@runoff/engine");
const { POST: postGolden } = await import("../app/api/blueprints/[id]/goldens/route");
const { bindExemplar } = await import("../lib/goldenPipeline");
const { resolveGolden, listGoldenSummaries } = await import("../lib/goldens");

const projectId = "proj_1";
let db: ReturnType<typeof getDb>;
let filesDir: string;

function seedBlueprint(): void {
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(projectId);
  db.sqlite
    .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES ('bp_1', 'R', 'C', ?, 1)")
    .run(projectId);
}

/** Point the blueprint's current revision at a content JSON (only sections/queries matter here). */
function setRevision(sections: { key: string; queries: { name: string; sql: string }[] }[]): void {
  const content = { title: "T", clientName: "C", eyebrow: "", dateline: "", sections, globalRules: [], delivery: { recipient: "", autoDeliverOnClear: false } };
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES ('rev_1', 'bp_1', 1, ?)")
    .run(JSON.stringify(content));
}

/** File a plain CSV into a periodic family via the island path, creating a real warehouse table. */
async function seedFamily(key: string, period: string, csv: string): Promise<string> {
  const stored = `${key}_${period}.csv`;
  writeFileSync(join(filesDir, stored), csv);
  const sourceId = `src_${key}_${period}`;
  db.sqlite
    .prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, ?, ?, ?, 'text/csv', 1)")
    .run(sourceId, projectId, stored, stored);
  const res = await fileSource(db, {
    projectId,
    sourceId,
    newFamily: { key, label: key, kind: "periodic", granularity: "quarter" },
    period,
  });
  if (!("ok" in res)) throw new Error(`seedFamily failed: ${JSON.stringify(res)}`);
  return (db.sqlite.prepare("SELECT id FROM source_families WHERE key = ?").get(key) as { id: string }).id;
}

function insertExemplar(
  id: string,
  opts: { name: string; document?: RunDocument; period?: string | null; bindings?: BindingInventory; unifyError?: string },
): void {
  db.sqlite
    .prepare(
      "INSERT INTO goldens (id, blueprint_id, kind, name, mime, period, document, bindings, unify_error) VALUES (?, 'bp_1', 'exemplar', ?, 'text/markdown', ?, ?, ?, ?)",
    )
    .run(
      id,
      opts.name,
      opts.period ?? null,
      opts.document ? JSON.stringify(opts.document) : null,
      opts.bindings ? JSON.stringify(opts.bindings) : null,
      opts.unifyError ?? null,
    );
}

beforeEach(() => {
  freshDb();
  unifyMock.mockReset();
  bindMock.mockReset();
  db = getDb();
  filesDir = process.env.RUNOFF_FILES_DIR!;
  mkdirSync(filesDir, { recursive: true });
  seedBlueprint();
});

describe("golden pipeline", () => {
  it("upload chain: unify → auto-bind → verify persists document, period, and warehouse-verified bindings", async () => {
    const famX = await seedFamily("x", "2026-Q1", "amount\n100\n50\n"); // SUM(amount) = 150
    const document: RunDocument = {
      title: "Q1 Report",
      eyebrow: "E",
      dateline: "D",
      sections: [
        { key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "Revenue was " }, { text: "$150" }] }] },
        { key: "outlook", heading: "Outlook", blocks: [{ type: "paragraph", spans: [{ text: "Steady." }] }] },
      ],
    };
    unifyMock.mockResolvedValueOnce({ document, period: "2026-Q1" });
    const submitted: SubmittedInventory = {
      version: 1,
      items: [
        {
          id: "rev",
          kind: "value",
          anchor: { sectionKey: "exec", blockIndex: 0, spanIndex: 1 },
          raw: "$150",
          parsed: 150,
          binding: { familyId: famX, sql: "SELECT SUM(amount) FROM fam_x WHERE _period = :period" },
          reason: null,
        },
      ],
    };
    bindMock.mockResolvedValueOnce(submitted);

    const form = new FormData();
    form.set("file", new File(["# Q1\nRevenue was $150"], "q1.md", { type: "text/markdown" }));
    const res = await postGolden(new Request("http://x", { method: "POST", body: form }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();

    // bind ran against the golden's period.
    expect(bindMock).toHaveBeenCalledTimes(1);
    expect(bindMock.mock.calls[0][0]).toMatchObject({ period: "2026-Q1" });

    const g = resolveGolden(db, id)!;
    expect(g.document?.title).toBe("Q1 Report");
    expect(g.period).toBe("2026-Q1");
    // verifiedValue is the WAREHOUSE-computed sum, proving verification executed real SQL.
    expect(g.inventory!.items[0].binding).toMatchObject({ status: "bound", verifiedValue: 150 });
  });

  it("unify failure persists 'unify failed: no document produced', no bindings, upload still 200", async () => {
    unifyMock.mockResolvedValueOnce(null);
    const form = new FormData();
    form.set("file", new File(["text"], "r.md", { type: "text/markdown" }));
    const res = await postGolden(new Request("http://x", { method: "POST", body: form }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const row = db.sqlite.prepare("SELECT unify_error AS e, document AS d, bindings AS b FROM goldens WHERE id = ?").get(id) as {
      e: string | null;
      d: string | null;
      b: string | null;
    };
    expect(row.e).toBe("unify failed: no document produced");
    expect(row.d).toBeNull();
    expect(row.b).toBeNull();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("unsupported mime persists the error and never calls unify", async () => {
    const form = new FormData();
    form.set("file", new File(["a,b\n1,2"], "data.csv", { type: "text/csv" }));
    const res = await postGolden(new Request("http://x", { method: "POST", body: form }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const row = db.sqlite.prepare("SELECT unify_error AS e FROM goldens WHERE id = ?").get(id) as { e: string | null };
    expect(row.e).toBe("unsupported exemplar type for unify: text/csv");
    expect(unifyMock).not.toHaveBeenCalled();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("star chain: deterministic inventory with anchor-derived ids, citation bound, period copied — no LLM", async () => {
    await seedFamily("x", "2026-Q1", "amount\n100\n50\n"); // SUM = 150
    setRevision([{ key: "exec", queries: [{ name: "q_x", sql: "SELECT amount FROM fam_x WHERE _period = :period" }] }]);
    const document: RunDocument = {
      title: "Run",
      eyebrow: "E",
      dateline: "D",
      sections: [
        {
          key: "exec",
          heading: "Exec",
          blocks: [
            {
              type: "paragraph",
              spans: [{ text: "Revenue was " }, { text: "$150", citation: { sourceId: "s1", locator: "sum(fam_x.amount)" } }],
            },
            { type: "table", columns: ["amount"], rows: [{ cells: [[{ text: "100" }]] }, { cells: [[{ text: "50" }]] }] },
          ],
        },
      ],
    };
    db.sqlite
      .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period, document) VALUES ('run_1', 'bp_1', 1, 'complete', '2026-Q1', ?)")
      .run(JSON.stringify(document));

    const res = await postGolden(jsonReq({ kind: "run", runId: "run_1" }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const g = resolveGolden(db, id)!;
    const value = g.inventory!.items.find((i) => i.kind === "value")!;
    expect(value.id).toBe("exec_b0_s1"); // anchor-derived: section_b<block>_s<span>
    expect(value.binding).toMatchObject({ status: "bound", verifiedValue: 150 });
    const table = g.inventory!.items.find((i) => i.kind === "table")!;
    expect(table.id).toBe("exec_b1");
    expect(table.binding?.status).toBe("bound");
    expect(g.period).toBe("2026-Q1"); // copied from the run
    expect(unifyMock).not.toHaveBeenCalled();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("sibling reuse: bindExemplar hands the agent the OTHER goldens' bound inventories", async () => {
    const invA: BindingInventory = {
      version: 1,
      items: [
        {
          id: "a_item",
          kind: "value",
          anchor: { sectionKey: "exec", blockIndex: 0, spanIndex: 0 },
          raw: "$1",
          parsed: 1,
          binding: { familyId: "f", sql: "SELECT 1", verifiedValue: 1, status: "bound" },
          reason: null,
        },
      ],
    };
    const doc: RunDocument = {
      title: "B",
      eyebrow: "E",
      dateline: "D",
      sections: [{ key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "x" }] }] }],
    };
    insertExemplar("gold_a", { name: "a.md", document: doc, period: "2026-Q1", bindings: invA });
    insertExemplar("gold_b", { name: "b.md", document: doc, period: "2026-Q2" });

    bindMock.mockResolvedValueOnce(null); // we only care about the args handed in
    await bindExemplar({ db, goldenId: "gold_b" });

    expect(bindMock).toHaveBeenCalledTimes(1);
    const args = bindMock.mock.calls[0][0] as { siblings: { inventory: BindingInventory }[] };
    expect(args.siblings[0].inventory.items[0].id).toBe("a_item");
    // failed bind leaves gold_b's bindings untouched (null).
    expect(db.sqlite.prepare("SELECT bindings AS b FROM goldens WHERE id = 'gold_b'").get()).toEqual({ b: null });
  });

  it("sibling degradation: one corrupt sibling row is skipped, the good sibling still reaches the agent", async () => {
    const invA: BindingInventory = {
      version: 1,
      items: [
        {
          id: "a_item",
          kind: "value",
          anchor: { sectionKey: "exec", blockIndex: 0, spanIndex: 0 },
          raw: "$1",
          parsed: 1,
          binding: { familyId: "f", sql: "SELECT 1", verifiedValue: 1, status: "bound" },
          reason: null,
        },
      ],
    };
    const doc: RunDocument = {
      title: "B",
      eyebrow: "E",
      dateline: "D",
      sections: [{ key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "x" }] }] }],
    };
    insertExemplar("gold_good", { name: "good.md", document: doc, period: "2026-Q1", bindings: invA });
    insertExemplar("gold_corrupt", { name: "corrupt.md", document: doc, period: "2026-Q2" });
    // Poke schema-drifted JSON into the corrupt sibling's bindings (non-null so it's selected).
    db.sqlite.prepare("UPDATE goldens SET bindings = ? WHERE id = 'gold_corrupt'").run('{"version":1,"items":[{"garbage":true}]}');
    insertExemplar("gold_target", { name: "target.md", document: doc, period: "2026-Q3" });

    bindMock.mockResolvedValueOnce(null);
    const res = await bindExemplar({ db, goldenId: "gold_target" });

    // The corrupt sibling did not turn the bind into a failure.
    expect(res).toEqual({ ok: false, error: "bind failed: no inventory produced" });
    expect(bindMock).toHaveBeenCalledTimes(1);
    const args = bindMock.mock.calls[0][0] as { siblings: { inventory: BindingInventory }[] };
    expect(args.siblings).toHaveLength(1);
    expect(args.siblings[0].inventory.items[0].id).toBe("a_item");
  });

  it("copilot cache render: bound exemplar carries « annotations; un-unified renders the inert one-liner", () => {
    const doc: RunDocument = {
      title: "Q1",
      eyebrow: "E",
      dateline: "D",
      sections: [{ key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "Revenue was " }, { text: "$150" }] }] }],
    };
    const inv: BindingInventory = {
      version: 1,
      items: [
        {
          id: "rev",
          kind: "value",
          anchor: { sectionKey: "exec", blockIndex: 0, spanIndex: 1 },
          raw: "$150",
          parsed: 150,
          binding: { familyId: "fam_x", sql: "SELECT SUM(amount) FROM fam_x WHERE _period = :period", verifiedValue: 150, status: "bound" },
          reason: null,
        },
      ],
    };
    insertExemplar("gold_bound", { name: "bound.md", document: doc, period: "2026-Q1", bindings: inv });
    insertExemplar("gold_inert", { name: "inert.md", unifyError: "unify failed: no document produced" });

    const boundText = renderGoldenForPrompt(resolveGolden(db, "gold_bound")!);
    expect(boundText).toContain("«");
    expect(boundText).toContain("fam_x");

    const inertText = renderGoldenForPrompt(resolveGolden(db, "gold_inert")!);
    expect(inertText).toBe('golden "inert.md" is not unified (unify failed: no document produced)');
  });

  it("graceful degradation: a golden with corrupt bindings JSON resolves with bindings null, never throws", () => {
    const doc: RunDocument = {
      title: "Q1",
      eyebrow: "E",
      dateline: "D",
      sections: [{ key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "Revenue was " }, { text: "$150" }] }] }],
    };
    // Insert an otherwise-good exemplar, then poke corrupt JSON into `bindings`.
    insertExemplar("gold_bad", { name: "bad.md", document: doc, period: "2026-Q1" });
    db.sqlite.prepare("UPDATE goldens SET bindings = ? WHERE id = 'gold_bad'").run("{not json");

    const g = resolveGolden(db, "gold_bad")!;
    expect(g).not.toBeNull();
    expect(g.document?.title).toBe("Q1"); // document still resolves
    expect(g.inventory).toBeNull(); // corrupt bindings degrade to null

    // Renders via the unbound path rather than throwing.
    const text = renderGoldenForPrompt(g);
    expect(text).toContain("boundness: not yet bound");

    // listGoldenSummaries guards the same parse.
    const summaries = listGoldenSummaries(db, "bp_1");
    const summary = summaries.find((s) => s.id === "gold_bad")!;
    expect(summary.label).toContain("not yet bound");
  });
});
