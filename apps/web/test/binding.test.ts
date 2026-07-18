import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, jsonReq, ctx } from "./helpers";
import { getDb } from "../lib/db";
import { GET as getBlueprint, PATCH as patchBlueprint } from "../app/api/blueprints/[id]/route";

// Family-level binding: PATCH { familyIds } replaces blueprint_families with a
// granularity guard (all bound periodic families must share one granularity),
// and GET surfaces every project family plus the bound ids.

const BP = "bp_bind";

function seed(): void {
  const db = getDb();
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_1','P')").run();
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_2','Other')").run();
  const fam = db.sqlite.prepare(
    "INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)",
  );
  fam.run("fam_q", "proj_1", "trade_data", "Trade data", "periodic", "quarter");
  fam.run("fam_m", "proj_1", "ga4", "GA4", "periodic", "month");
  fam.run("fam_c", "proj_1", "brand", "Brand", "constant", null);
  fam.run("fam_other_project", "proj_2", "foreign", "Foreign", "periodic", "quarter");
  // A filed source in fam_q so filedPeriods is meaningful in the GET assertion.
  db.sqlite
    .prepare(
      "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES ('src_q1','proj_1','fam_q','2026-Q1','q1.csv','sf_q1','text/csv',1,'filed')",
    )
    .run();
  db.sqlite
    .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, 'R', 'C', 'proj_1', 1)")
    .run(BP);
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES ('rev_1', ?, 1, ?)")
    .run(BP, JSON.stringify({ title: "R", clientName: "C", eyebrow: "", dateline: "", sections: [], globalRules: [], delivery: { recipient: "", autoDeliverOnClear: false } }));
}

function boundRows(): string[] {
  return (getDb().sqlite.prepare("SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ? ORDER BY family_id").all(BP) as { familyId: string }[]).map((r) => r.familyId);
}

beforeEach(() => {
  freshDb();
  seed();
});

describe("PATCH /api/blueprints/:id family binding", () => {
  it("binds a compatible set (quarter + constant) and replaces blueprint_families", async () => {
    const res = await patchBlueprint(jsonReq({ familyIds: ["fam_q", "fam_c"] }, "PATCH"), ctx(BP));
    expect(res.status).toBe(200);
    expect(boundRows()).toEqual(["fam_c", "fam_q"]);
  });

  it("rejects a mixed-granularity periodic set (400) and leaves rows unchanged", async () => {
    await patchBlueprint(jsonReq({ familyIds: ["fam_q", "fam_c"] }, "PATCH"), ctx(BP));
    const res = await patchBlueprint(jsonReq({ familyIds: ["fam_q", "fam_m"] }, "PATCH"), ctx(BP));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("granularity differs among bound periodic families");
    expect(boundRows()).toEqual(["fam_c", "fam_q"]);
  });

  it("rejects a family from another project (400) and leaves rows unchanged", async () => {
    const res = await patchBlueprint(jsonReq({ familyIds: ["fam_q", "fam_other_project"] }, "PATCH"), ctx(BP));
    expect(res.status).toBe(400);
    expect(boundRows()).toEqual([]);
  });

  it("rejects an unknown family id (400)", async () => {
    const res = await patchBlueprint(jsonReq({ familyIds: ["fam_nope"] }, "PATCH"), ctx(BP));
    expect(res.status).toBe(400);
    expect(boundRows()).toEqual([]);
  });

  it("unbinds when given an empty array", async () => {
    await patchBlueprint(jsonReq({ familyIds: ["fam_q"] }, "PATCH"), ctx(BP));
    await patchBlueprint(jsonReq({ familyIds: [] }, "PATCH"), ctx(BP));
    expect(boundRows()).toEqual([]);
  });
});

describe("GET /api/blueprints/:id families + boundFamilyIds", () => {
  it("returns every project family (with filedPeriods) and the bound ids; no legacy sources key", async () => {
    await patchBlueprint(jsonReq({ familyIds: ["fam_q", "fam_c"] }, "PATCH"), ctx(BP));
    const res = await getBlueprint(new Request("http://x"), ctx(BP));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("sources");
    expect(body.project).toEqual({ id: "proj_1", name: "P" });
    expect(body.families.map((f: { id: string }) => f.id).sort()).toEqual(["fam_c", "fam_m", "fam_q"]);
    const q = body.families.find((f: { key: string }) => f.key === "trade_data");
    expect(q.filedPeriods).toEqual(["2026-Q1"]);
    expect(body.boundFamilyIds.sort()).toEqual(["fam_c", "fam_q"]);
  });
});
