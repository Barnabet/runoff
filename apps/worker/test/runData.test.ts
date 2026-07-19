import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, attachWarehouse, applySchema, insertRows, detachWarehouse, type RunoffDb } from "@runoff/core";
import { buildRunData } from "../src/runData.js";

// setup: project proj1 with families famA (key "ar", periodic/quarter, filed 2026-Q1)
// and famB (key "brand", constant, no warehouse tables — a document family);
// warehouse table fam_ar(amount REAL) with 2 rows in 2026-Q1.
let db: RunoffDb;
let whDir: string;

beforeEach(() => {
  whDir = mkdtempSync(join(tmpdir(), "runoff-rundata-wh-"));
  process.env.RUNOFF_WAREHOUSE_DIR = whDir;
  db = openDb(join(mkdtempSync(join(tmpdir(), "runoff-rundata-")), "t.db"));
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj1', 'P')").run();
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('famA','proj1','ar','Accounts Receivable','periodic','quarter')")
    .run();
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('famB','proj1','brand','Brand Guide','constant',NULL)")
    .run();
  db.sqlite
    .prepare("INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES ('src1','proj1','famA','2026-Q1','ar-q1.csv','src1.csv','text/csv',0,'filed')")
    .run();

  // Warehouse: fam_ar(amount REAL) with 2 rows filed for 2026-Q1. Written through
  // the app connection (attach must be outside a transaction), then detached so
  // buildRunData opens the committed file with its own read-only connection.
  attachWarehouse(db.sqlite, "proj1");
  applySchema(db.sqlite, true, [{ name: "fam_ar", columns: [{ name: "amount", type: "REAL" }] }]);
  insertRows(db.sqlite, "fam_ar", ["amount"], [[100], [200]], "2026-Q1");
  detachWarehouse(db.sqlite);
});

afterEach(() => {
  db.sqlite.close();
  delete process.env.RUNOFF_WAREHOUSE_DIR;
});

describe("buildRunData", () => {
  it("builds a catalog restricted to bound families, with queryability", () => {
    const data = buildRunData(db, "proj1", ["famA", "famB"], "2026-Q1");
    expect(data.catalog.map((f) => f.id).sort()).toEqual(["famA", "famB"]);
    const ar = data.catalog.find((f) => f.id === "famA")!;
    expect(ar.queryable).toBe(true);
    expect(ar.tables[0].name).toBe("fam_ar");
    expect(data.catalog.find((f) => f.id === "famB")!.queryable).toBe(false);
  });

  it("exec binds the run period", () => {
    const data = buildRunData(db, "proj1", ["famA"], "2026-Q1");
    const res = data.exec("SELECT COUNT(*) FROM fam_ar WHERE _period = :period");
    expect(res.rows[0][0]).toBe(2);
  });

  it("exec surfaces the missing-period error for period-less runs", () => {
    const data = buildRunData(db, "proj1", ["famA"], null);
    expect(() => data.exec("SELECT COUNT(*) FROM fam_ar WHERE _period = :period"))
      .toThrow("query references :period but no period was provided");
  });
});
