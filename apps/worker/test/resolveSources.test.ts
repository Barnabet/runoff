import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RunoffDb } from "@runoff/core";
import { resolveRunSources } from "../src/resolveSources.js";

function tempDb(): RunoffDb {
  return openDb(join(mkdtempSync(join(tmpdir(), "runoff-resolve-")), "t.db"));
}

function addFamily(
  db: RunoffDb,
  f: { id: string; key: string; label: string; kind: "periodic" | "constant"; granularity?: string | null },
): void {
  db.sqlite
    .prepare(
      "INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, 'proj_1', ?, ?, ?, ?)",
    )
    .run(f.id, f.key, f.label, f.kind, f.granularity ?? null);
}

function addSource(
  db: RunoffDb,
  s: { id: string; familyId: string; period: string | null; name: string; storedFilename: string; mime?: string; status: string },
): void {
  db.sqlite
    .prepare(
      "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES (?, 'proj_1', ?, ?, ?, ?, ?, 0, ?)",
    )
    .run(s.id, s.familyId, s.period, s.name, s.storedFilename, s.mime ?? "text/csv", s.status);
}

function bind(db: RunoffDb, blueprintId: string, familyId: string): void {
  db.sqlite.prepare("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)").run(blueprintId, familyId);
}

describe("resolveRunSources", () => {
  it("resolves a periodic slot + a constant family; ids are family ids, gaps empty", () => {
    const db = tempDb();
    addFamily(db, { id: "fam_spend", key: "spend", label: "Spend Data", kind: "periodic", granularity: "quarter" });
    addFamily(db, { id: "fam_rates", key: "rates", label: "Rate Card", kind: "constant" });
    addSource(db, { id: "src_q1", familyId: "fam_spend", period: "2026-Q1", name: "spend-q1.csv", storedFilename: "src_q1.csv", status: "filed" });
    addSource(db, { id: "src_rate", familyId: "fam_rates", period: null, name: "rates.csv", storedFilename: "src_rate.csv", status: "filed" });
    bind(db, "bp_1", "fam_spend");
    bind(db, "bp_1", "fam_rates");

    const { files, gaps } = resolveRunSources(db, "bp_1", "2026-Q1");
    expect(gaps).toEqual([]);
    // ordered by family key: rates, spend
    const byId = Object.fromEntries(files.map((f) => [f.id, f]));
    expect(new Set(files.map((f) => f.id))).toEqual(new Set(["fam_spend", "fam_rates"]));
    expect(byId.fam_spend.name).toBe("Spend Data");
    expect(byId.fam_rates.name).toBe("Rate Card");
    expect(byId.fam_spend.path.endsWith("src_q1.csv")).toBe(true);
    expect(byId.fam_rates.path.endsWith("src_rate.csv")).toBe(true);
  });

  it("puts a bound family with no file for the period in gaps (by key); replaced rows never resolve", () => {
    const db = tempDb();
    addFamily(db, { id: "fam_spend", key: "spend", label: "Spend Data", kind: "periodic", granularity: "quarter" });
    // A replaced (superseded) row for the exact slot must not resolve.
    addSource(db, { id: "src_old", familyId: "fam_spend", period: "2026-Q1", name: "old.csv", storedFilename: "old.csv", status: "replaced" });
    bind(db, "bp_1", "fam_spend");

    const { files, gaps } = resolveRunSources(db, "bp_1", "2026-Q1");
    expect(files).toEqual([]);
    expect(gaps).toEqual(["spend"]);
  });

  it("resolves constants under a null period; a periodic family with no null-slot file is a gap", () => {
    const db = tempDb();
    addFamily(db, { id: "fam_rates", key: "rates", label: "Rate Card", kind: "constant" });
    addFamily(db, { id: "fam_spend", key: "spend", label: "Spend Data", kind: "periodic", granularity: "quarter" });
    addSource(db, { id: "src_rate", familyId: "fam_rates", period: null, name: "rates.csv", storedFilename: "src_rate.csv", status: "filed" });
    // Periodic family has a Q1 file, but the run period is null → no match for its slot.
    addSource(db, { id: "src_q1", familyId: "fam_spend", period: "2026-Q1", name: "spend.csv", storedFilename: "src_q1.csv", status: "filed" });
    bind(db, "bp_1", "fam_rates");
    bind(db, "bp_1", "fam_spend");

    const { files, gaps } = resolveRunSources(db, "bp_1", null);
    expect(files.map((f) => f.id)).toEqual(["fam_rates"]);
    expect(gaps).toEqual(["spend"]);
  });
});
