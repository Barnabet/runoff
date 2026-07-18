import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, jsonReq, ctx } from "./helpers";
import * as projects from "../app/api/projects/route";
import * as project from "../app/api/projects/[id]/route";

// A fresh temp DB + files dir per test; see test/helpers.ts.
beforeEach(freshDb);

describe("/api/projects", () => {
  it("creates, lists, renames, and fetches a project", async () => {
    const created = await projects.POST(jsonReq({ name: "Acme" }));
    const { id } = (await created.json()) as { id: string };
    expect(id).toMatch(/^proj_/);

    const listed = await (await projects.GET()).json();
    expect(listed.projects.map((p: { name: string }) => p.name)).toContain("Acme");
    expect(listed.projects[0]).toHaveProperty("blueprintCount");
    expect(listed.projects[0]).toHaveProperty("lastActivityAt");

    await project.PATCH(jsonReq({ name: "Acme 2" }, "PATCH"), ctx(id));
    const got = await (await project.GET(new Request("http://t"), ctx(id))).json();
    expect(got.project.name).toBe("Acme 2");
    expect(got.blueprints).toEqual([]);
  });

  it("400s on a blank name and 404s on unknown ids", async () => {
    expect((await projects.POST(jsonReq({ name: "  " }))).status).toBe(400);
    expect((await project.GET(new Request("http://t"), ctx("proj_missing"))).status).toBe(404);
  });

  it("POST /api/blueprints requires a valid projectId and scopes the listing", async () => {
    const bp = await import("../app/api/blueprints/route");
    const noProject = await bp.POST(jsonReq({ name: "B", clientName: "C" }));
    expect(noProject.status).toBe(400);

    const badProject = await bp.POST(jsonReq({ name: "B", clientName: "C", projectId: "proj_nope" }));
    expect(badProject.status).toBe(400);

    const p = await (await projects.POST(jsonReq({ name: "Acme" }))).json();
    const ok = await bp.POST(jsonReq({ name: "B", clientName: "C", projectId: p.id }));
    expect(ok.status).toBe(200);

    const payload = await (await project.GET(new Request("http://t"), ctx(p.id))).json();
    expect(payload.blueprints).toHaveLength(1);
    expect(payload.blueprints[0].name).toBe("B");

    // GET /api/blueprints requires a projectId and scopes to it.
    expect((await bp.GET(new Request("http://t/api/blueprints"))).status).toBe(400);
    const scoped = await (await bp.GET(new Request(`http://t/api/blueprints?projectId=${p.id}`))).json();
    expect(scoped.blueprints).toHaveLength(1);
  });
});
