import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { previousCompletedDocument } from "../src/db/previousRun.js";

const DOC = JSON.stringify({ title: "Prev", eyebrow: "E", dateline: "D", sections: [] });

function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "runoff-core-")), "t.db"));
}

function insertRun(
  db: ReturnType<typeof openDb>,
  id: string,
  over: { status?: string; createdAt?: string; finishedAt?: string | null; document?: string | null; blueprintId?: string } = {},
) {
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at, finished_at, document)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.blueprintId ?? "bp_1",
      over.status ?? "complete",
      over.createdAt ?? "2026-07-01 09:00:00",
      over.finishedAt === undefined ? "2026-07-01 09:10:00" : over.finishedAt,
      over.document === undefined ? DOC : over.document,
    );
}

describe("previousCompletedDocument", () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns the latest complete predecessor with its parsed document", () => {
    insertRun(db, "run_old", { createdAt: "2026-06-01 09:00:00", finishedAt: "2026-06-01 09:09:00" });
    insertRun(db, "run_prev", { createdAt: "2026-07-01 09:00:00" });
    insertRun(db, "run_cur", { status: "running", createdAt: "2026-07-18 09:00:00", document: null, finishedAt: null });

    const prev = previousCompletedDocument(db.sqlite, "bp_1", {
      runId: "run_cur",
      createdAt: "2026-07-18 09:00:00",
    });
    expect(prev?.runId).toBe("run_prev");
    expect(prev?.completedAt).toBe("2026-07-01 09:10:00");
    expect(prev?.document.title).toBe("Prev");
  });

  it("skips non-complete, newer, other-blueprint runs and itself", () => {
    insertRun(db, "run_queued", { status: "queued", createdAt: "2026-07-01 09:00:00" });
    insertRun(db, "run_failed", { status: "failed", createdAt: "2026-07-02 09:00:00" });
    insertRun(db, "run_other", { blueprintId: "bp_2", createdAt: "2026-07-03 09:00:00" });
    insertRun(db, "run_newer", { createdAt: "2026-07-20 09:00:00" });
    insertRun(db, "run_cur", { createdAt: "2026-07-18 09:00:00" });

    const prev = previousCompletedDocument(db.sqlite, "bp_1", {
      runId: "run_cur",
      createdAt: "2026-07-18 09:00:00",
    });
    expect(prev).toBeNull();
  });

  it("falls back to created_at when finished_at is NULL", () => {
    insertRun(db, "run_prev", { createdAt: "2026-07-01 09:00:00", finishedAt: null });
    const prev = previousCompletedDocument(db.sqlite, "bp_1", {
      runId: "run_cur",
      createdAt: "2026-07-18 09:00:00",
    });
    expect(prev?.completedAt).toBe("2026-07-01 09:00:00");
  });

  it("returns null when the document column is NULL or unparseable", () => {
    insertRun(db, "run_nodoc", { createdAt: "2026-07-01 09:00:00", document: null });
    expect(
      previousCompletedDocument(db.sqlite, "bp_1", { runId: "run_cur", createdAt: "2026-07-18 09:00:00" }),
    ).toBeNull();

    insertRun(db, "run_baddoc", { createdAt: "2026-07-02 09:00:00", document: "{not json" });
    expect(
      previousCompletedDocument(db.sqlite, "bp_1", { runId: "run_cur", createdAt: "2026-07-18 09:00:00" }),
    ).toBeNull();
  });
});
