import json

import pytest
from fastapi.testclient import TestClient

from runoff_api.core.jsonutil import to_json
from runoff_api.main import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        yield c, app.state.db


# --- seed helpers -----------------------------------------------------------


def _project(db, id, name="Proj", created_at="2026-07-01 00:00:00"):
    db.execute("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", (id, name, created_at))


def _blueprint(db, id, project_id, name="BP", created_at="2026-07-02 00:00:00", current_rev=1, **over):
    db.execute(
        """INSERT INTO blueprints (id, name, client_name, project_id, cadence_label, status,
                current_rev, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            id,
            name,
            over.get("client_name", "Acme"),
            project_id,
            over.get("cadence_label", "Monthly"),
            over.get("status", "draft"),
            current_rev,
            created_at,
        ),
    )


def _revision(db, id, blueprint_id, rev, content):
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, ?, ?)",
        (id, blueprint_id, rev, to_json(content)),
    )


def _family(db, id, project_id, key, label, kind, granularity):
    db.execute(
        """INSERT INTO source_families (id, project_id, key, label, kind, granularity)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (id, project_id, key, label, kind, granularity),
    )


def _source(db, id, project_id, **over):
    db.execute(
        """INSERT INTO sources (id, project_id, family_id, period, name, kind, stored_filename,
                mime, size, status, proposal, uploaded_at)
           VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)""",
        (
            id,
            project_id,
            over.get("family_id"),
            over.get("period"),
            over.get("name", "file.csv"),
            over.get("stored_filename", f"{id}_file.csv"),
            over.get("mime", "text/csv"),
            over.get("size", 10),
            over.get("status", "filed"),
            over.get("proposal"),
            over.get("uploaded_at", "2026-07-01 00:00:00"),
        ),
    )


def _run(db, id, blueprint_id, **over):
    db.execute(
        """INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period, document, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            id,
            blueprint_id,
            over.get("blueprint_rev", 1),
            over.get("status", "complete"),
            over.get("period", "2026-06"),
            over.get("document"),
            over.get("created_at", "2026-07-01 09:00:00"),
        ),
    )


def _valid_content(title="T"):
    return {
        "title": title,
        "clientName": "Acme",
        "eyebrow": "",
        "dateline": "",
        "sections": [],
        "globalRules": [],
        "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }


# --- POST /projects ---------------------------------------------------------


def test_create_project_invalid_json(client):
    c, db = client
    res = c.post("/api/v1/projects", content="not json", headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}


def test_create_project_name_required(client):
    c, db = client
    res = c.post("/api/v1/projects", json={"name": "   "})
    assert res.status_code == 400
    assert res.json() == {"error": "name required"}


def test_create_project_ok(client):
    c, db = client
    res = c.post("/api/v1/projects", json={"name": "  Acme Co  "})
    assert res.status_code == 200
    pid = res.json()["id"]
    assert pid.startswith("proj_")
    row = db.execute("SELECT name FROM projects WHERE id = ?", (pid,)).fetchone()
    assert row["name"] == "Acme Co"  # trimmed


# --- PATCH /projects/{id} ---------------------------------------------------


def test_patch_project_404_before_body(client):
    c, db = client
    # 404 comes first — even with an invalid body, missing project wins.
    res = c.patch("/api/v1/projects/nope", content="garbage")
    assert res.status_code == 404
    assert res.json() == {"error": "project not found"}


def test_patch_project_name_required(client):
    c, db = client
    _project(db, "p1")
    res = c.patch("/api/v1/projects/p1", json={"name": ""})
    assert res.status_code == 400
    assert res.json() == {"error": "name required"}


def test_patch_project_ok(client):
    c, db = client
    _project(db, "p1", name="Old")
    res = c.patch("/api/v1/projects/p1", json={"name": "  New  "})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert db.execute("SELECT name FROM projects WHERE id = 'p1'").fetchone()["name"] == "New"


# --- POST /blueprints -------------------------------------------------------


def test_create_blueprint_missing_name(client):
    c, db = client
    _project(db, "p1")
    res = c.post("/api/v1/blueprints", json={"projectId": "p1"})
    assert res.status_code == 400
    assert res.json() == {"error": "name is required"}


def test_create_blueprint_missing_project_id(client):
    c, db = client
    res = c.post("/api/v1/blueprints", json={"name": "BP"})
    assert res.status_code == 400
    assert res.json() == {"error": "projectId is required"}


def test_create_blueprint_unknown_project_id(client):
    c, db = client
    res = c.post("/api/v1/blueprints", json={"name": "BP", "projectId": "ghost"})
    assert res.status_code == 400
    assert res.json() == {"error": "unknown projectId"}


def test_create_blueprint_creates_blueprint_and_revision(client):
    c, db = client
    _project(db, "p1")
    res = c.post("/api/v1/blueprints", json={"name": "  My BP ", "clientName": "Acme", "projectId": "p1"})
    assert res.status_code == 200
    bid = res.json()["id"]
    assert bid.startswith("bp_")
    bp = db.execute(
        "SELECT name, client_name AS clientName, current_rev AS currentRev FROM blueprints WHERE id = ?",
        (bid,),
    ).fetchone()
    assert bp["name"] == "My BP"
    assert bp["clientName"] == "Acme"
    assert bp["currentRev"] == 1
    rev = db.execute(
        "SELECT rev, content FROM blueprint_revisions WHERE blueprint_id = ?", (bid,)
    ).fetchone()
    assert rev["rev"] == 1
    content = json.loads(rev["content"])
    assert content["title"] == "My BP"
    assert content["clientName"] == "Acme"
    assert content["sections"] == []
    assert content["delivery"] == {"recipient": "", "autoDeliverOnClear": False}


# --- PATCH /blueprints/{id} -------------------------------------------------


def test_patch_blueprint_404(client):
    c, db = client
    res = c.patch("/api/v1/blueprints/nope", json={"name": "x"})
    assert res.status_code == 404
    assert res.json() == {"error": "blueprint not found"}


def test_patch_blueprint_partial_columns(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1")
    res = c.patch("/api/v1/blueprints/bp1", json={"name": "Renamed", "status": "active", "extra": 1})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    row = db.execute("SELECT name, status FROM blueprints WHERE id = 'bp1'").fetchone()
    assert row["name"] == "Renamed"
    assert row["status"] == "active"


def test_patch_blueprint_unknown_family(client):
    c, db = client
    _project(db, "p1")
    _project(db, "p2")
    _blueprint(db, "bp1", "p1")
    _family(db, "fam_other", "p2", "sales", "Sales", "periodic", "month")
    # Family belongs to a different project → unknown for this blueprint's project.
    res = c.patch("/api/v1/blueprints/bp1", json={"familyIds": ["fam_other"]})
    assert res.status_code == 400
    assert res.json() == {"error": "unknown family for this project"}
    # No rows written.
    remaining = db.execute(
        "SELECT COUNT(*) AS n FROM blueprint_families WHERE blueprint_id='bp1'"
    ).fetchone()["n"]
    assert remaining == 0


def test_patch_blueprint_mixed_granularity(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1")
    _family(db, "fam_m", "p1", "sales", "Sales", "periodic", "month")
    _family(db, "fam_q", "p1", "revenue", "Revenue", "periodic", "quarter")
    res = c.patch("/api/v1/blueprints/bp1", json={"familyIds": ["fam_m", "fam_q"]})
    assert res.status_code == 400
    assert res.json() == {"error": "granularity differs among bound periodic families"}


def test_patch_blueprint_replaces_families(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1")
    _family(db, "fam_a", "p1", "a", "A", "periodic", "month")
    _family(db, "fam_b", "p1", "b", "B", "constant", None)
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1', 'fam_old')")
    res = c.patch("/api/v1/blueprints/bp1", json={"familyIds": ["fam_a", "fam_b"]})
    assert res.status_code == 200
    ids = [
        r["family_id"]
        for r in db.execute(
            "SELECT family_id FROM blueprint_families WHERE blueprint_id='bp1' ORDER BY family_id"
        ).fetchall()
    ]
    assert ids == ["fam_a", "fam_b"]


# --- POST /blueprints/{id}/revisions ----------------------------------------


def test_post_revision_404(client):
    c, db = client
    res = c.post("/api/v1/blueprints/nope/revisions", json={"content": _valid_content()})
    assert res.status_code == 404
    assert res.json() == {"error": "blueprint not found"}


def test_post_revision_invalid_content(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1")
    res = c.post("/api/v1/blueprints/bp1/revisions", json={"content": {"title": "only"}})
    assert res.status_code == 400
    body = res.json()
    assert body["error"] == "invalid blueprint content"
    assert isinstance(body["issues"], list)
    assert len(body["issues"]) > 0


def test_post_revision_bumps_rev(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=3)
    _revision(db, "rev3", "bp1", 3, _valid_content("old"))
    res = c.post("/api/v1/blueprints/bp1/revisions", json={"content": _valid_content("new")})
    assert res.status_code == 200
    assert res.json() == {"rev": 4}
    assert db.execute("SELECT current_rev AS r FROM blueprints WHERE id='bp1'").fetchone()["r"] == 4
    stored = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id='bp1' AND rev=4"
    ).fetchone()
    assert json.loads(stored["content"])["title"] == "new"


# --- POST /blueprints/{id}/goldens ------------------------------------------


def test_post_golden_multipart_501(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    res = c.post("/api/v1/blueprints/bp1/goldens", files={"file": ("x.pdf", b"data", "application/pdf")})
    assert res.status_code == 501
    assert res.json() == {"error": "exemplar upload not yet implemented in this backend (R3)"}


def test_post_golden_invalid_kind(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    res = c.post("/api/v1/blueprints/bp1/goldens", json={"kind": "bogus", "runId": "r1"})
    assert res.status_code == 400
    assert res.json() == {"error": "kind ('run'|'section') and runId are required"}


def test_post_golden_section_requires_section_key(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    res = c.post("/api/v1/blueprints/bp1/goldens", json={"kind": "section", "runId": "r1"})
    assert res.status_code == 400
    assert res.json() == {"error": "sectionKey is required for kind 'section'"}


def test_post_golden_run_not_found(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    res = c.post("/api/v1/blueprints/bp1/goldens", json={"kind": "run", "runId": "ghost"})
    assert res.status_code == 404
    assert res.json() == {"error": "run not found for this blueprint"}


def test_post_golden_run_other_blueprint(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _blueprint(db, "bp2", "p1")
    _run(db, "r_other", "bp2")
    res = c.post("/api/v1/blueprints/bp1/goldens", json={"kind": "run", "runId": "r_other"})
    assert res.status_code == 404
    assert res.json() == {"error": "run not found for this blueprint"}


def test_post_golden_run_copies_period_and_rebuilds(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=1)
    _revision(db, "rev1", "bp1", 1, _valid_content())
    # A completed document with a cited span so rebuild writes a non-null bindings.
    doc = {
        "title": "T",
        "sections": [
            {
                "key": "s1",
                "blocks": [
                    {
                        "type": "paragraph",
                        "spans": [
                            {
                                "text": "$4.2M",
                                "citation": {"locator": "sum(sales.amount)"},
                            }
                        ],
                    }
                ],
            }
        ],
    }
    _run(db, "r1", "bp1", period="2026-05", document=to_json(doc))
    res = c.post("/api/v1/blueprints/bp1/goldens", json={"kind": "run", "runId": "r1", "note": "nice"})
    assert res.status_code == 200
    gid = res.json()["id"]
    assert gid.startswith("gold_")
    row = db.execute(
        "SELECT kind, run_id AS runId, period, note, bindings FROM goldens WHERE id = ?", (gid,)
    ).fetchone()
    assert row["kind"] == "run"
    assert row["runId"] == "r1"
    assert row["period"] == "2026-05"  # copied from the run
    assert row["note"] == "nice"
    # rebuild_run_golden_inventory ran and wrote a bindings inventory.
    assert row["bindings"] is not None
    inv = json.loads(row["bindings"])
    assert inv["version"] == 1
    assert len(inv["items"]) == 1


# --- PATCH /goldens/{id} ----------------------------------------------------


def test_patch_golden_invalid_period(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    db.execute("INSERT INTO goldens (id, blueprint_id, kind) VALUES ('g1', 'bp1', 'run')")
    res = c.patch("/api/v1/goldens/g1", json={"period": "not-a-period"})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid period: not-a-period"}


def test_patch_golden_non_string_period(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    db.execute("INSERT INTO goldens (id, blueprint_id, kind) VALUES ('g1', 'bp1', 'run')")
    # TS RegExp.test coerces 123 → "123", which matches no period regex.
    res = c.patch("/api/v1/goldens/g1", json={"period": 123})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid period: 123"}


def test_patch_golden_missing_period_key(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    db.execute("INSERT INTO goldens (id, blueprint_id, kind) VALUES ('g1', 'bp1', 'run')")
    # TS destructures undefined → RegExp.test("undefined") → 400.
    res = c.patch("/api/v1/goldens/g1", json={})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid period: undefined"}


def test_patch_golden_non_dict_body(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    db.execute("INSERT INTO goldens (id, blueprint_id, kind) VALUES ('g1', 'bp1', 'run')")
    res = c.patch("/api/v1/goldens/g1", json=[1, 2, 3])
    assert res.status_code == 400
    assert res.json() == {"error": "invalid period: undefined"}


def test_patch_golden_null_period_clears_and_reverifies(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    inv = {
        "version": 1,
        "items": [
            {
                "id": "s1_b0_s0",
                "kind": "value",
                "anchor": {"sectionKey": "s1", "blockIndex": 0, "spanIndex": 0},
                "raw": "$1",
                "parsed": 1,
                "reason": None,
                "binding": {"familyId": "fam1", "sql": "SELECT 1", "verifiedValue": 1, "status": "bound"},
            }
        ],
    }
    doc = {
        "title": "T",
        "sections": [{"key": "s1", "blocks": [{"type": "paragraph", "spans": [{"text": "$1"}]}]}],
    }
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, period, document, bindings) "
        "VALUES ('g1','bp1','exemplar','2026-05',?,?)",
        (to_json(doc), to_json(inv)),
    )
    res = c.patch("/api/v1/goldens/g1", json={"period": None})
    assert res.status_code == 200
    row = db.execute("SELECT period, bindings FROM goldens WHERE id='g1'").fetchone()
    assert row["period"] is None  # cleared
    verified = json.loads(row["bindings"])
    assert verified["items"][0]["binding"]["status"] == "error"  # re-verified


def test_patch_golden_404(client):
    c, db = client
    res = c.patch("/api/v1/goldens/nope", json={"period": None})
    assert res.status_code == 404
    assert res.json() == {"error": "golden not found"}


def test_patch_golden_run_kind_rebuilds(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=1)
    _revision(db, "rev1", "bp1", 1, _valid_content())
    doc = {
        "title": "T",
        "sections": [
            {
                "key": "s1",
                "blocks": [
                    {
                        "type": "paragraph",
                        "spans": [{"text": "$1", "citation": {"locator": "sum(sales.amount)"}}],
                    }
                ],
            }
        ],
    }
    _run(db, "r1", "bp1", period="2026-05", document=to_json(doc))
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, run_id) VALUES ('g1', 'bp1', 'run', 'r1')"
    )
    # Bindings start empty; run/section dispatch must go through rebuild.
    assert db.execute("SELECT bindings FROM goldens WHERE id='g1'").fetchone()["bindings"] is None
    res = c.patch("/api/v1/goldens/g1", json={"period": "2026-06"})
    assert res.status_code == 200
    body = res.json()
    assert body["golden"]["id"] == "g1"
    assert body["golden"]["period"] == "2026-06"
    assert db.execute("SELECT period FROM goldens WHERE id='g1'").fetchone()["period"] == "2026-06"
    # rebuild_run_golden_inventory ran: the seeded citation became one inventory item.
    # (verify_stored_inventory would have no-op'd on the empty stored inventory.)
    bindings = db.execute("SELECT bindings FROM goldens WHERE id='g1'").fetchone()["bindings"]
    assert bindings is not None
    inv = json.loads(bindings)
    assert len(inv["items"]) == 1


def test_patch_golden_exemplar_verifies(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    # Exemplar with a stored inventory whose one item is stamped 'bound', plus a
    # document. verify re-executes every binding from scratch; with no warehouse
    # the SQL errors, so the stamp must flip 'bound' → 'error'. A swapped dispatch
    # (rebuild) would instead derive an empty inventory from the citation-less doc.
    inv = {
        "version": 1,
        "items": [
            {
                "id": "s1_b0_s0",
                "kind": "value",
                "anchor": {"sectionKey": "s1", "blockIndex": 0, "spanIndex": 0},
                "raw": "$1",
                "parsed": 1,
                "reason": None,
                "binding": {"familyId": "fam1", "sql": "SELECT 1", "verifiedValue": 1, "status": "bound"},
            }
        ],
    }
    doc = {
        "title": "T",
        "sections": [{"key": "s1", "blocks": [{"type": "paragraph", "spans": [{"text": "$1"}]}]}],
    }
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, document, bindings) "
        "VALUES ('g1','bp1','exemplar',?,?)",
        (to_json(doc), to_json(inv)),
    )
    res = c.patch("/api/v1/goldens/g1", json={"period": None})
    assert res.status_code == 200
    assert res.json()["golden"]["id"] == "g1"
    verified = json.loads(db.execute("SELECT bindings FROM goldens WHERE id='g1'").fetchone()["bindings"])
    assert len(verified["items"]) == 1
    assert verified["items"][0]["binding"]["status"] == "error"


# --- DELETE /goldens/{id} ---------------------------------------------------


def test_delete_golden_404(client):
    c, db = client
    res = c.delete("/api/v1/goldens/nope")
    assert res.status_code == 404
    assert res.json() == {"error": "golden not found"}


def test_delete_golden_removes_row_and_file(client, tmp_path, monkeypatch):
    c, db = client
    files_dir = tmp_path / "files"
    files_dir.mkdir()
    stored = files_dir / "g1_x.pdf"
    stored.write_bytes(b"data")
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files_dir))
    _blueprint(db, "bp1", "p1")
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, stored_filename) "
        "VALUES ('g1','bp1','exemplar','g1_x.pdf')"
    )
    res = c.delete("/api/v1/goldens/g1")
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert db.execute("SELECT COUNT(*) AS n FROM goldens WHERE id='g1'").fetchone()["n"] == 0
    assert not stored.exists()


def test_delete_golden_missing_file_tolerated(client, tmp_path, monkeypatch):
    c, db = client
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(tmp_path / "files"))
    _blueprint(db, "bp1", "p1")
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, stored_filename) "
        "VALUES ('g1','bp1','exemplar','gone.pdf')"
    )
    res = c.delete("/api/v1/goldens/g1")
    assert res.status_code == 200
    assert db.execute("SELECT COUNT(*) AS n FROM goldens WHERE id='g1'").fetchone()["n"] == 0


# --- PATCH /memories/{id} ---------------------------------------------------


def test_patch_memory_invalid_status(client):
    c, db = client
    res = c.patch("/api/v1/memories/m1", json={"status": "bogus"})
    assert res.status_code == 400
    assert res.json() == {"error": "status must be 'active' or 'disabled'"}


def test_patch_memory_404(client):
    c, db = client
    res = c.patch("/api/v1/memories/nope", json={"status": "disabled"})
    assert res.status_code == 404
    assert res.json() == {"error": "memory not found"}


def test_patch_memory_ok(client):
    c, db = client
    db.execute(
        "INSERT INTO memories (id, scope, body, source, status) "
        "VALUES ('m1','blueprint','b','copilot','active')"
    )
    res = c.patch("/api/v1/memories/m1", json={"status": "disabled"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert db.execute("SELECT status FROM memories WHERE id='m1'").fetchone()["status"] == "disabled"


# --- DELETE /memories/{id} --------------------------------------------------


def test_delete_memory_404(client):
    c, db = client
    res = c.delete("/api/v1/memories/nope")
    assert res.status_code == 404
    assert res.json() == {"error": "memory not found"}


def test_delete_memory_ok(client):
    c, db = client
    db.execute(
        "INSERT INTO memories (id, scope, body, source, status) "
        "VALUES ('m1','blueprint','b','copilot','active')"
    )
    res = c.delete("/api/v1/memories/m1")
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert db.execute("SELECT COUNT(*) AS n FROM memories WHERE id='m1'").fetchone()["n"] == 0


# --- POST /flags/{id} -------------------------------------------------------


def test_post_flag_option_required(client):
    c, db = client
    res = c.post("/api/v1/flags/f1", json={})
    assert res.status_code == 400
    assert res.json() == {"error": "option is required"}


def test_post_flag_404(client):
    c, db = client
    res = c.post("/api/v1/flags/nope", json={"option": "a"})
    assert res.status_code == 404
    assert res.json() == {"error": "flag not found"}


def test_post_flag_resolves_and_counts_open(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _run(db, "r1", "bp1")
    for fid, status in [("f1", "open"), ("f2", "open"), ("f3", "resolved")]:
        db.execute(
            "INSERT INTO flags (id, run_id, code, section_key, question, options, status) "
            "VALUES (?, 'r1', 'C', 's', 'q?', '[]', ?)",
            (fid, status),
        )
    res = c.post("/api/v1/flags/f1", json={"option": "yes", "note": "because"})
    assert res.status_code == 200
    # f2 remains open for the same run
    assert res.json() == {"remainingOpen": 1}
    row = db.execute("SELECT status, resolution FROM flags WHERE id='f1'").fetchone()
    assert row["status"] == "resolved"
    assert row["resolution"] == '{"option":"yes","note":"because"}'  # compact JSON


# --- POST /runs -------------------------------------------------------------


def test_create_run_blueprint_not_found(client):
    c, db = client
    res = c.post("/api/v1/runs", json={"blueprintId": "ghost"})
    assert res.status_code == 404
    assert res.json() == {"error": "blueprint not found"}


def test_create_run_period_not_available(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=1)
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1','fam1')")
    _source(db, "s1", "p1", family_id="fam1", period="2026-06", status="filed")
    # Periodic blueprint but no matching period supplied.
    res = c.post("/api/v1/runs", json={"blueprintId": "bp1", "period": "2020-01"})
    assert res.status_code == 400
    assert res.json() == {"error": "period not available for this blueprint"}


def test_create_run_periodic_ok(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=5)
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1','fam1')")
    _source(db, "s1", "p1", family_id="fam1", period="2026-06", status="filed")
    res = c.post("/api/v1/runs", json={"blueprintId": "bp1", "period": "2026-06"})
    assert res.status_code == 200
    rid = res.json()["id"]
    assert rid.startswith("run_")
    row = db.execute(
        "SELECT status, period, blueprint_rev AS rev FROM runs WHERE id = ?", (rid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["period"] == "2026-06"
    assert row["rev"] == 5  # pinned to current_rev


def test_create_run_constants_only_rejects_period(client):
    c, db = client
    _project(db, "p1")
    _blueprint(db, "bp1", "p1", current_rev=1)
    _family(db, "fam1", "p1", "roster", "Roster", "constant", None)
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1','fam1')")
    # Constants-only requires period=None; supplying one is rejected.
    res = c.post("/api/v1/runs", json={"blueprintId": "bp1", "period": "2026-06"})
    assert res.status_code == 400
    assert res.json() == {"error": "period not available for this blueprint"}
    # And None is accepted.
    res2 = c.post("/api/v1/runs", json={"blueprintId": "bp1"})
    assert res2.status_code == 200
    rid = res2.json()["id"]
    assert db.execute("SELECT period FROM runs WHERE id=?", (rid,)).fetchone()["period"] is None


# --- POST /runs/{id}/inputs -------------------------------------------------


def test_post_input_invalid_kind(client):
    c, db = client
    res = c.post("/api/v1/runs/r1/inputs", json={"kind": "bogus"})
    assert res.status_code == 400
    assert res.json() == {"error": "kind must be one of pause|resume|steer|answer"}


def test_post_input_run_not_found(client):
    c, db = client
    res = c.post("/api/v1/runs/ghost/inputs", json={"kind": "pause"})
    assert res.status_code == 404
    assert res.json() == {"error": "run not found"}


def test_post_input_steer_inserts(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _run(db, "r1", "bp1")
    res = c.post("/api/v1/runs/r1/inputs", json={"kind": "steer", "text": "focus here"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    rows = db.execute("SELECT kind, payload FROM run_inputs WHERE run_id='r1'").fetchall()
    assert len(rows) == 1
    assert rows[0]["kind"] == "steer"
    assert json.loads(rows[0]["payload"]) == {"text": "focus here"}


def test_post_input_answer_replaces_pending(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _run(db, "r1", "bp1")
    first = c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "q1", "text": "a"})
    assert first.status_code == 200
    second = c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "q1", "text": "b"})
    assert second.status_code == 200
    rows = db.execute("SELECT payload FROM run_inputs WHERE run_id='r1' AND kind='answer'").fetchall()
    # Re-answer replaced the pending row instead of inserting a second.
    assert len(rows) == 1
    assert json.loads(rows[0]["payload"])["text"] == "b"


def test_post_input_answer_new_when_consumed(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _run(db, "r1", "bp1")
    c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "q1", "text": "a"})
    # Mark the pending answer consumed, so a re-answer inserts a fresh row.
    db.execute("UPDATE run_inputs SET consumed_at = '2026-07-01' WHERE run_id='r1'")
    c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "q1", "text": "b"})
    rows = db.execute("SELECT payload FROM run_inputs WHERE run_id='r1' AND kind='answer'").fetchall()
    assert len(rows) == 2


def test_post_input_answer_empty_question_id_inserts(client):
    c, db = client
    _blueprint(db, "bp1", "p1")
    _run(db, "r1", "bp1")
    # An empty-string questionId is falsy (TS `payload.questionId`), so the
    # replacement branch is skipped and each answer INSERTs a fresh row.
    c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "", "text": "a"})
    c.post("/api/v1/runs/r1/inputs", json={"kind": "answer", "questionId": "", "text": "b"})
    rows = db.execute("SELECT payload FROM run_inputs WHERE run_id='r1' AND kind='answer'").fetchall()
    assert len(rows) == 2
