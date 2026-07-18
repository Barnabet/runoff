import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { blueprints } from "../src/db/schema.js";
import { newId } from "../src/ids.js";

describe("openDb", () => {
  it("creates tables and accepts inserts", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "runoff-")), "t.db"));
    const id = newId("bp");
    db.orm.insert(blueprints).values({ id, name: "Monthly Performance Report", clientName: "Meridian Retail" }).run();
    const rows = db.orm.select().from(blueprints).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(id).toMatch(/^bp_[0-9a-f]{12}$/);
  });

  it("throws the reseed guard when opening a pre-v1.2b database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "runoff-old-")), "old.db");
    // Simulate a pre-v1.2b file: a `sources` table without the taxonomy columns.
    const raw = new Database(path);
    raw.exec("CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    raw.close();
    expect(() => openDb(path)).toThrow(/database predates v1\.2b — delete the DB file and run: pnpm seed/);
  });
});
