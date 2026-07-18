import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";

describe("v1.2a tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-core-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("boot DDL creates copilot_messages, memories, and goldens", () => {
    const db = openDb(join(dir, "t.db"));
    const names = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('copilot_messages','memories','goldens') ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(["copilot_messages", "goldens", "memories"]);

    // Defaults: status columns and timestamps land without being supplied.
    db.sqlite
      .prepare("INSERT INTO memories (id, blueprint_id, body, source) VALUES ('m1','bp1','Always use percentages','copilot')")
      .run();
    const m = db.sqlite.prepare("SELECT status, created_at AS createdAt FROM memories WHERE id='m1'").get() as {
      status: string; createdAt: string;
    };
    expect(m.status).toBe("active");
    expect(m.createdAt).toBeTruthy();
    db.sqlite.close();
  });
});
