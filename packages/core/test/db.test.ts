import { describe, it, expect } from "vitest";
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
});
