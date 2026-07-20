import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, openDb, type RunoffDb } from "../src/index.js";
import { attachWarehouse, applySchema, detachWarehouse, insertRows, type WhTableSchema } from "../src/warehouse.js";
import { buildWarehouseCatalog } from "../src/warehouseCatalog.js";

// core cannot import apps/web fileSource, so the fixture is built from core
// primitives: family + source rows via direct SQL, and the warehouse table via
// core's own warehouse writers (attach → applySchema → insertRows → detach), the
// same minimal sequence apps/web/lib/sourceManager.ts uses.
let db: RunoffDb;
let projectId: string;

beforeAll(() => {
  process.env.RUNOFF_WAREHOUSE_DIR = mkdtempSync(join(tmpdir(), "wh-"));
  db = openDb(join(mkdtempSync(join(tmpdir(), "db-")), "t.db"));
  projectId = newId("proj");
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(projectId, "P");

  // One periodic family with a filed source for 2026-Q1 and a real warehouse table.
  const periodicId = newId("fam");
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)")
    .run(periodicId, projectId, "a_sales", "Sales", "periodic", "quarter");
  const sourceId = newId("src");
  db.sqlite
    .prepare(
      "INSERT INTO sources (id, project_id, family_id, name, stored_filename, mime, size, period, status) VALUES (?, ?, ?, ?, ?, 'text/csv', 1, ?, 'filed')",
    )
    .run(sourceId, projectId, periodicId, "sales.csv", "sales.csv", "2026-Q1");

  attachWarehouse(db.sqlite, projectId);
  try {
    db.sqlite.exec("BEGIN IMMEDIATE");
    const incoming: WhTableSchema[] = [{ name: "fam_a_sales", columns: [{ name: "amount", type: "INTEGER" }] }];
    applySchema(db.sqlite, true, incoming);
    insertRows(db.sqlite, "fam_a_sales", ["amount"], [[100], [50]], "2026-Q1");
    db.sqlite.exec("COMMIT");
  } finally {
    detachWarehouse(db.sqlite);
  }

  // One constant family with no filed source and no warehouse table.
  const constantId = newId("fam");
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)")
    .run(constantId, projectId, "b_notes", "Notes", "constant", null);
});

describe("buildWarehouseCatalog", () => {
  it("families in key order, queryable iff warehouse tables exist, filedPeriods only for periodic", () => {
    const cat = buildWarehouseCatalog(db, projectId);
    expect(cat.map((f) => f.key)).toEqual([...cat.map((f) => f.key)].sort());
    const periodic = cat.find((f) => f.kind === "periodic")!;
    expect(periodic.queryable).toBe(true);
    expect(periodic.filedPeriods).toEqual(["2026-Q1"]);
    expect(periodic.tables[0].rowCounts["2026-Q1"]).toBeGreaterThan(0);
    const constant = cat.find((f) => f.kind === "constant")!;
    expect(constant.queryable).toBe(false);
    expect(constant.filedPeriods).toEqual([]);
  });
});
