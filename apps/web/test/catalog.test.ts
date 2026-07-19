import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "./helpers";
import { getDb } from "../lib/db";
import { fileSource } from "../lib/sourceManager";
import { catalog } from "../lib/catalog";

beforeEach(() => {
  freshDb();
});

describe("catalog", () => {
  const projectId = "proj_1";

  function seed() {
    const db = getDb();
    db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(projectId);
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_spend', ?, 'spend', 'Spend', 'periodic', 'quarter')").run(projectId);
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_brand', ?, 'brand', 'Brand', 'constant', NULL)").run(projectId);
    const filesDir = process.env.RUNOFF_FILES_DIR!;
    mkdirSync(filesDir, { recursive: true });
    const add = (id: string, name: string, stored: string, mime: string) =>
      db.sqlite.prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, ?, ?, ?, ?, 1)").run(id, projectId, name, stored, mime);
    writeFileSync(join(filesDir, "q1.csv"), "campaign,spend\nbrand,100\nsearch,200\n");
    writeFileSync(join(filesDir, "q2.csv"), "campaign,spend\nvideo,300\n");
    writeFileSync(join(filesDir, "doc.pdf"), "just prose, no table");
    add("q1", "q1.csv", "q1.csv", "text/csv");
    add("q2", "q2.csv", "q2.csv", "text/csv");
    add("doc", "doc.pdf", "doc.pdf", "application/pdf");
    return db;
  }

  it("catalog() combines app-db families with warehouse schema and counts", async () => {
    const db = seed();
    await fileSource(db, { projectId, sourceId: "q1", familyId: "fam_spend", period: "2026-Q1" });
    await fileSource(db, { projectId, sourceId: "q2", familyId: "fam_spend", period: "2026-Q2" });
    await fileSource(db, { projectId, sourceId: "doc", familyId: "fam_brand", period: null });

    const cat = catalog(db, projectId);
    const spend = cat.find((f) => f.key === "spend")!;
    expect(spend.queryable).toBe(true);
    expect(spend.granularity).toBe("quarter");
    expect(spend.filedPeriods).toEqual(["2026-Q1", "2026-Q2"]);
    expect(spend.tables[0].name).toBe("fam_spend");
    expect(spend.tables[0].rowCounts).toEqual({ "2026-Q1": 2, "2026-Q2": 1 });
    const brand = cat.find((f) => f.key === "brand")!;
    expect(brand.queryable).toBe(false);
    expect(brand.tables).toEqual([]);
    expect(brand.filedPeriods).toEqual([]);
  });
});
