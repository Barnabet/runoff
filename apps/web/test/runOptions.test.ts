import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, jsonReq } from "./helpers";
import { getDb } from "../lib/db";
import { getRunOptions } from "../lib/runOptions";
import { POST as createRun } from "../app/api/runs/route";

// Run options: for a blueprint, the periods any bound periodic family has filed
// (descending), a per-period presence checklist, and the constant-family
// checklist. Drives the RunDialog and validates POST /api/runs.

const PROJECT_ID = "proj_1";

/**
 * Blueprint bound to fam_q (quarter; 2026-Q1, 2026-Q2), fam_q2 (quarter;
 * 2026-Q2 only), fam_c (constant; one live file). Returns its id.
 */
function seedPeriodicBlueprint(): string {
  const db = getDb();
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(PROJECT_ID);
  const fam = db.sqlite.prepare(
    "INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)",
  );
  fam.run("fam_q", PROJECT_ID, "trade", "Trade data", "periodic", "quarter");
  fam.run("fam_q2", PROJECT_ID, "web", "Web traffic", "periodic", "quarter");
  fam.run("fam_c", PROJECT_ID, "brand", "Brand kit", "constant", null);

  const src = db.sqlite.prepare(
    "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES (?, ?, ?, ?, ?, ?, 'text/csv', 1, 'filed')",
  );
  src.run("src_q_1", PROJECT_ID, "fam_q", "2026-Q1", "trade Q1", "sf1");
  src.run("src_q_2", PROJECT_ID, "fam_q", "2026-Q2", "trade Q2", "sf2");
  src.run("src_q2_2", PROJECT_ID, "fam_q2", "2026-Q2", "web Q2", "sf3");
  // Constant family: one live file (period NULL, filed).
  db.sqlite
    .prepare(
      "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES ('src_c', ?, 'fam_c', NULL, 'brand kit', 'sfc', 'application/pdf', 1, 'filed')",
    )
    .run(PROJECT_ID);

  const bp = "bp_1";
  db.sqlite
    .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, 'R', 'C', ?, 1)")
    .run(bp, PROJECT_ID);
  const bind = db.sqlite.prepare("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)");
  bind.run(bp, "fam_q");
  bind.run(bp, "fam_q2");
  bind.run(bp, "fam_c");
  return bp;
}

/** Blueprint bound to a single constant family only (no periodic families). */
function seedConstantsBlueprint(): string {
  const db = getDb();
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(PROJECT_ID);
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_c', ?, 'brand', 'Brand kit', 'constant', NULL)")
    .run(PROJECT_ID);
  const bp = "bp_c";
  db.sqlite
    .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, 'R', 'C', ?, 1)")
    .run(bp, PROJECT_ID);
  db.sqlite.prepare("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, 'fam_c')").run(bp);
  return bp;
}

beforeEach(() => {
  freshDb();
});

describe("getRunOptions", () => {
  it("returns null for a missing blueprint", () => {
    expect(getRunOptions(getDb(), "bp_missing")).toBeNull();
  });

  it("lists periods descending with a per-period presence checklist and constants", () => {
    const bp = seedPeriodicBlueprint();
    const opts = getRunOptions(getDb(), bp)!;

    expect(opts.granularity).toBe("quarter");
    expect(opts.periods.map((p) => p.period)).toEqual(["2026-Q2", "2026-Q1"]);

    // 2026-Q2: both periodic families present.
    const q2 = opts.periods.find((p) => p.period === "2026-Q2")!;
    expect(q2.families.find((f) => f.key === "trade")!.present).toBe(true);
    expect(q2.families.find((f) => f.key === "web")!.present).toBe(true);

    // 2026-Q1: fam_q present, fam_q2 (web) absent.
    const q1 = opts.periods.find((p) => p.period === "2026-Q1")!;
    expect(q1.families.find((f) => f.key === "trade")!.present).toBe(true);
    expect(q1.families.find((f) => f.key === "web")!.present).toBe(false);

    // Constant family present.
    expect(opts.constants).toEqual([{ key: "brand", label: "Brand kit", present: true }]);
  });

  it("returns granularity null and no periods for a constants-only blueprint", () => {
    const bp = seedConstantsBlueprint();
    const opts = getRunOptions(getDb(), bp)!;
    expect(opts.granularity).toBeNull();
    expect(opts.periods).toEqual([]);
    expect(opts.constants).toEqual([{ key: "brand", label: "Brand kit", present: false }]);
  });
});

describe("POST /api/runs — period validation", () => {
  it("accepts a listed period and stamps it on the run row", async () => {
    const bp = seedPeriodicBlueprint();
    const res = await createRun(jsonReq({ blueprintId: bp, period: "2026-Q1" }));
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const row = getDb().sqlite.prepare("SELECT period FROM runs WHERE id = ?").get(id) as { period: string };
    expect(row.period).toBe("2026-Q1");
  });

  it("rejects an unlisted period with 400", async () => {
    const bp = seedPeriodicBlueprint();
    const res = await createRun(jsonReq({ blueprintId: bp, period: "2025-Q4" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("period not available for this blueprint");
  });

  it("rejects a null period when the blueprint has periodic families", async () => {
    const bp = seedPeriodicBlueprint();
    const res = await createRun(jsonReq({ blueprintId: bp, period: null }));
    expect(res.status).toBe(400);
  });

  it("accepts period null for a constants-only blueprint and rejects a period", async () => {
    const bp = seedConstantsBlueprint();
    const ok = await createRun(jsonReq({ blueprintId: bp, period: null }));
    expect(ok.status).toBe(200);
    const { id } = await ok.json();
    const row = getDb().sqlite.prepare("SELECT period FROM runs WHERE id = ?").get(id) as { period: string | null };
    expect(row.period).toBeNull();

    const bad = await createRun(jsonReq({ blueprintId: bp, period: "2026-Q1" }));
    expect(bad.status).toBe(400);
  });
});
