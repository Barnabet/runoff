import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachWarehouse, detachWarehouse, whFamilyTables, computeDrift, applySchema,
  deleteRows, insertRows, readWarehouseTables, runWarehouseSql, formatSqlResult,
  type WhTableSchema,
} from "../src/warehouse.js";

let dir: string;
let app: Database.Database;
const PROJECT = "proj_test";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-"));
  process.env.RUNOFF_WAREHOUSE_DIR = dir;
  app = new Database(":memory:");
  attachWarehouse(app, PROJECT);
});
afterEach(() => {
  try { detachWarehouse(app); } catch {}
  app.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNOFF_WAREHOUSE_DIR;
});

const SPEND: WhTableSchema = {
  name: "fam_spend",
  columns: [{ name: "campaign", type: "TEXT" }, { name: "amount", type: "INTEGER" }],
};

describe("schema + ingest", () => {
  it("creates periodic tables with _period and swaps one period on re-ingest", () => {
    applySchema(app, true, [SPEND]);
    insertRows(app, "fam_spend", ["campaign", "amount"], [["a", 10], ["b", 20]], "2026-Q1");
    insertRows(app, "fam_spend", ["campaign", "amount"], [["c", 30]], "2026-Q2");
    deleteRows(app, ["fam_spend"], "2026-Q1");
    insertRows(app, "fam_spend", ["campaign", "amount"], [["a2", 11]], "2026-Q1");
    const rows = app.prepare("SELECT campaign, amount, _period FROM wh.fam_spend ORDER BY _period, campaign").all();
    expect(rows).toEqual([
      { campaign: "a2", amount: 11, _period: "2026-Q1" },
      { campaign: "c", amount: 30, _period: "2026-Q2" },
    ]);
  });

  it("constant tables have no _period and deleteRows(null) clears all", () => {
    applySchema(app, false, [{ name: "fam_guide", columns: [{ name: "note", type: "TEXT" }] }]);
    insertRows(app, "fam_guide", ["note"], [["x"]], null);
    expect(app.prepare("SELECT COUNT(*) AS n FROM wh.fam_guide").get()).toEqual({ n: 1 });
    expect(() => app.prepare("SELECT _period FROM wh.fam_guide").get()).toThrow();
    deleteRows(app, ["fam_guide"], null);
    expect(app.prepare("SELECT COUNT(*) AS n FROM wh.fam_guide").get()).toEqual({ n: 0 });
  });

  it("adds new columns and widens INTEGER→REAL→TEXT preserving values", () => {
    applySchema(app, true, [SPEND]);
    insertRows(app, "fam_spend", ["campaign", "amount"], [["a", 10]], "2026-Q1");
    applySchema(app, true, [{
      name: "fam_spend",
      columns: [{ name: "campaign", type: "TEXT" }, { name: "amount", type: "REAL" }, { name: "region", type: "TEXT" }],
    }]);
    const schema = whFamilyTables(app, "spend");
    expect(schema[0].columns).toEqual([
      { name: "campaign", type: "TEXT" }, { name: "amount", type: "REAL" }, { name: "region", type: "TEXT" },
    ]);
    expect(app.prepare("SELECT campaign, amount, region FROM wh.fam_spend").get())
      .toEqual({ campaign: "a", amount: 10, region: null });
    // narrowing attempt is a no-op
    applySchema(app, true, [{ name: "fam_spend", columns: [{ name: "campaign", type: "TEXT" }, { name: "amount", type: "INTEGER" }, { name: "region", type: "TEXT" }] }]);
    expect(whFamilyTables(app, "spend")[0].columns.find((c) => c.name === "amount")!.type).toBe("REAL");
  });

  it("whFamilyTables scopes by key without prefix collisions", () => {
    applySchema(app, true, [{ name: "fam_a", columns: [{ name: "x", type: "TEXT" }] }]);
    applySchema(app, true, [{ name: "fam_a_b", columns: [{ name: "y", type: "TEXT" }] }]);
    applySchema(app, true, [{ name: "fam_a__part", columns: [{ name: "z", type: "TEXT" }] }]);
    expect(whFamilyTables(app, "a").map((t) => t.name).sort()).toEqual(["fam_a", "fam_a__part"]);
    expect(whFamilyTables(app, "a_b").map((t) => t.name)).toEqual(["fam_a_b"]);
  });
});

describe("computeDrift", () => {
  const base: WhTableSchema[] = [SPEND];
  it("returns [] for a brand-new family", () => {
    expect(computeDrift([], base)).toEqual([]);
  });
  it("reports all five drift cases", () => {
    const incoming: WhTableSchema[] = [
      { name: "fam_spend", columns: [{ name: "campaign", type: "TEXT" }, { name: "amount", type: "REAL" }, { name: "refund_flag", type: "REAL" }] },
      { name: "fam_spend__extra", columns: [{ name: "k", type: "TEXT" }, { name: "v", type: "TEXT" }] },
    ];
    const existing: WhTableSchema[] = [...base, { name: "fam_spend__old", columns: [{ name: "k", type: "TEXT" }] }];
    expect(computeDrift(existing, incoming)).toEqual([
      "new table: fam_spend__extra",
      "missing table: fam_spend__old",
      "new column: fam_spend.refund_flag (REAL)",
      "type change: fam_spend.amount INTEGER → REAL",
    ]);
    // missing column case
    expect(computeDrift(base, [{ name: "fam_spend", columns: [{ name: "campaign", type: "TEXT" }] }]))
      .toEqual(["missing column: fam_spend.amount"]);
  });
});

describe("runWarehouseSql + formatSqlResult", () => {
  beforeEach(() => {
    applySchema(app, true, [SPEND]);
    insertRows(app, "fam_spend", ["campaign", "amount"], [["a", 10], ["b", 20]], "2026-Q1");
  });
  it("runs SELECTs read-only against the warehouse file", () => {
    const res = runWarehouseSql(PROJECT, "SELECT campaign, amount FROM fam_spend ORDER BY campaign");
    expect(res.columns).toEqual(["campaign", "amount"]);
    expect(res.rows).toEqual([["a", 10], ["b", 20]]);
  });
  it("rejects writes and multi-statement strings", () => {
    expect(() => runWarehouseSql(PROJECT, "INSERT INTO fam_spend (campaign) VALUES ('x')")).toThrow();
    expect(() => runWarehouseSql(PROJECT, "DROP TABLE fam_spend")).toThrow();
    expect(() => runWarehouseSql(PROJECT, "SELECT 1; SELECT 2")).toThrow();
  });
  it("throws 'no data ingested yet' when the warehouse file does not exist", () => {
    expect(() => runWarehouseSql("proj_none", "SELECT 1")).toThrow("no data ingested yet");
  });
  it("formats, caps at 200 rows, and reports truncation byte-exactly", () => {
    expect(formatSqlResult({ columns: ["a"], rows: [] })).toBe("(0 rows)");
    expect(formatSqlResult({ columns: ["a", "b"], rows: [[1, "x"], [2, null]] }))
      .toBe("a | b\n1 | x\n2 | ");
    const big = { columns: ["n"], rows: Array.from({ length: 250 }, (_, i) => [i]) };
    const out = formatSqlResult(big);
    expect(out.split("\n").length).toBe(202); // header + 200 rows + truncation line
    expect(out.endsWith("… truncated at 200 of 250 rows")).toBe(true);
  });
  it("caps serialized output at 10k chars with the same line", () => {
    const wide = { columns: ["t"], rows: Array.from({ length: 150 }, () => ["y".repeat(200)]) };
    const out = formatSqlResult(wide);
    expect(out.length).toBeLessThanOrEqual(10_000 + "… truncated at 49 of 150 rows".length + 1);
    expect(out).toMatch(/… truncated at \d+ of 150 rows$/);
  });

  describe("runWarehouseSql :period binding", () => {
    it("binds :period when the SQL references it", () => {
      const res = runWarehouseSql(PROJECT, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period", { period: "2026-Q1" });
      expect(res.rows[0][0]).toBeGreaterThan(0);
    });

    it("throws byte-exact when :period is referenced but not provided", () => {
      expect(() => runWarehouseSql(PROJECT, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period"))
        .toThrow("query references :period but no period was provided");
      expect(() => runWarehouseSql(PROJECT, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period", { period: null }))
        .toThrow("query references :period but no period was provided");
    });

    it("ignores params when the SQL does not reference :period", () => {
      const res = runWarehouseSql(PROJECT, "SELECT COUNT(*) FROM fam_spend", { period: "2026-Q1" });
      expect(res.columns).toEqual(["COUNT(*)"]);
    });
  });

  it("readWarehouseTables returns schema + per-period counts", () => {
    insertRows(app, "fam_spend", ["campaign", "amount"], [["c", 5]], "2026-Q2");
    const tables = readWarehouseTables(PROJECT, "spend");
    expect(tables).toEqual([{
      name: "fam_spend",
      columns: SPEND.columns,
      rowCounts: { "2026-Q1": 2, "2026-Q2": 1 },
    }]);
  });
});
