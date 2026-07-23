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


def _project(db, id, name, created_at):
    db.execute(
        "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", (id, name, created_at)
    )


def _blueprint(db, id, project_id, name, created_at, current_rev=1, **over):
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
        """INSERT INTO runs (id, blueprint_id, blueprint_rev, trigger_kind, status, period,
                started_at, finished_at, stats, document, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            id,
            blueprint_id,
            over.get("blueprint_rev", 1),
            over.get("trigger_kind", "manual"),
            over.get("status", "complete"),
            over.get("period", "2026-06"),
            over.get("started_at", "2026-07-01 09:00:00"),
            over.get("finished_at", "2026-07-01 09:10:00"),
            over.get("stats"),
            over.get("document"),
            over.get("created_at", "2026-07-01 09:00:00"),
        ),
    )


def _memory(db, id, body, scope, project_id="", blueprint_id=None, source="copilot"):
    db.execute(
        """INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')""",
        (id, scope, project_id, blueprint_id, body, source),
    )


# --- GET /projects ----------------------------------------------------------


def test_get_projects_ordered_with_counts_and_activity(client):
    c, db = client
    _project(db, "p_old", "Old", "2026-06-01 00:00:00")
    _project(db, "p_new", "New", "2026-07-01 00:00:00")
    _blueprint(db, "bp_1", "p_new", "BP", "2026-07-02 00:00:00")
    _run(db, "run_1", "bp_1", created_at="2026-07-05 10:00:00")

    res = c.get("/api/v1/projects")
    assert res.status_code == 200
    projects = res.json()["projects"]
    assert [p["id"] for p in projects] == ["p_new", "p_old"]
    assert projects[0]["blueprintCount"] == 1
    assert projects[0]["lastActivityAt"] == "2026-07-05 10:00:00"
    assert projects[1]["blueprintCount"] == 0
    assert projects[1]["lastActivityAt"] is None


# --- GET /projects/{id} -----------------------------------------------------


def test_get_project_404(client):
    c, db = client
    res = c.get("/api/v1/projects/nope")
    assert res.status_code == 404
    assert res.json() == {"error": "project not found"}


def test_get_project_payload(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    _run(db, "r1", "bp1", created_at="2026-07-03 00:00:00")
    db.execute(
        "INSERT INTO flags (id, run_id, code, section_key, question, options, status) "
        "VALUES ('f1', 'r1', 'C1', 's', 'q', '[]', 'open')"
    )
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    _source(db, "s1", "p1", family_id="fam1", period="2026-06", status="filed")
    _source(db, "s2", "p1", status="unfiled", proposal=to_json({"a": 1}))
    _memory(db, "m1", "project note", "project", project_id="p1")
    _memory(db, "m2", "blueprint note", "blueprint", blueprint_id="bp1")

    res = c.get("/api/v1/projects/p1")
    assert res.status_code == 200
    body = res.json()
    assert body["project"] == {"id": "p1", "name": "Proj", "createdAt": "2026-07-01 00:00:00"}
    assert len(body["blueprints"]) == 1
    assert body["blueprints"][0]["lastRun"]["openFlags"] == 1
    assert len(body["families"]) == 1
    assert body["unfiled"][0]["proposal"] == {"a": 1}
    # project scope only, so blueprint-scoped m2 excluded
    assert [m["id"] for m in body["memories"]] == ["m1"]


# --- GET /projects/{id}/sources ---------------------------------------------


def test_get_project_sources_404(client):
    c, db = client
    res = c.get("/api/v1/projects/nope/sources")
    assert res.status_code == 404
    assert res.json() == {"error": "project not found"}


def test_get_project_sources_payload(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    # Two families, ordered by key ascending: "roster" (constant) then "sales" (periodic).
    _family(db, "fam_sales", "p1", "sales", "Sales", "periodic", "month")
    _family(db, "fam_roster", "p1", "roster", "Roster", "constant", None)
    # Periodic family with two filed periods (inserted out of order to prove sorting).
    _source(db, "s_jun", "p1", family_id="fam_sales", period="2026-06", status="filed", name="jun.csv")
    _source(db, "s_may", "p1", family_id="fam_sales", period="2026-05", status="filed", name="may.csv")
    # Constant family with a live null-period file.
    _source(db, "s_live", "p1", family_id="fam_roster", period=None, status="filed", name="roster.csv")
    # One unfiled upload carrying a proposal JSON.
    _source(db, "s_unf", "p1", status="unfiled", name="new.csv", proposal=to_json({"plan": {"x": 1}}))

    res = c.get("/api/v1/projects/p1/sources")
    assert res.status_code == 200
    body = res.json()

    fams = body["families"]
    # Families ordered by key ascending.
    assert [f["key"] for f in fams] == ["roster", "sales"]

    roster = fams[0]
    assert roster["kind"] == "constant"
    assert roster["filedPeriods"] == []
    assert roster["filedEntries"] == []
    assert roster["liveFile"] == {"sourceId": "s_live", "name": "roster.csv"}
    assert roster["tables"] == []

    sales = fams[1]
    assert sales["kind"] == "periodic"
    # filedPeriods / filedEntries ascending by period.
    assert sales["filedPeriods"] == ["2026-05", "2026-06"]
    assert [e["period"] for e in sales["filedEntries"]] == ["2026-05", "2026-06"]
    assert sales["filedEntries"][0] == {"period": "2026-05", "sourceId": "s_may", "name": "may.csv"}
    assert sales["liveFile"] is None
    assert sales["tables"] == []

    # Unfiled upload with its proposal parsed to a dict.
    assert len(body["unfiled"]) == 1
    assert body["unfiled"][0]["id"] == "s_unf"
    assert body["unfiled"][0]["proposal"] == {"plan": {"x": 1}}


# --- GET /blueprints --------------------------------------------------------


def test_get_blueprints_requires_project_id(client):
    c, db = client
    res = c.get("/api/v1/blueprints")
    assert res.status_code == 400
    assert res.json() == {"error": "projectId is required"}


def test_get_blueprints_list(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    res = c.get("/api/v1/blueprints", params={"projectId": "p1"})
    assert res.status_code == 200
    blueprints = res.json()["blueprints"]
    assert len(blueprints) == 1
    assert blueprints[0]["id"] == "bp1"
    assert blueprints[0]["lastRun"] is None


# --- GET /blueprints/{id} ---------------------------------------------------


def test_get_blueprint_404(client):
    c, db = client
    res = c.get("/api/v1/blueprints/nope")
    assert res.status_code == 404
    assert res.json() == {"error": "blueprint not found"}


def test_get_blueprint_payload(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00", current_rev=1)
    content = {
        "title": "T",
        "sections": [
            {"key": "s1", "number": 1, "heading": "H", "queries": [{"name": "q1", "sql": "SELECT 1"}]},
            {"key": "s2", "number": 2, "heading": "H2", "queries": []},
        ],
    }
    _revision(db, "rev1", "bp1", 1, content)
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1', 'fam1')")

    res = c.get("/api/v1/blueprints/bp1")
    assert res.status_code == 200
    body = res.json()
    assert body["blueprint"]["projectId"] == "p1"
    assert body["content"]["title"] == "T"
    assert body["project"] == {"id": "p1", "name": "Proj"}
    assert body["boundFamilyIds"] == ["fam1"]
    # section with a query present (None since no warehouse); section without omitted
    assert body["queryRowCounts"] == {"s1": {"q1": None}}


def test_get_blueprint_project_stub_when_missing(client):
    c, db = client
    _blueprint(db, "bp1", "gone", "BP", "2026-07-02 00:00:00", current_rev=1)
    res = c.get("/api/v1/blueprints/bp1")
    assert res.status_code == 200
    body = res.json()
    assert body["project"] == {"id": "gone", "name": ""}
    assert body["content"] is None
    assert body["queryRowCounts"] == {}


# --- GET /blueprints/{id}/run-options ---------------------------------------


def test_get_run_options_404(client):
    c, db = client
    res = c.get("/api/v1/blueprints/nope/run-options")
    assert res.status_code == 404
    assert res.json() == {"error": "blueprint not found"}


def test_get_run_options(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    _family(db, "fam2", "p1", "roster", "Roster", "constant", None)
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1', 'fam1')")
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1', 'fam2')")
    _source(db, "s1", "p1", family_id="fam1", period="2026-05", status="filed")
    _source(db, "s2", "p1", family_id="fam1", period="2026-06", status="filed")
    _source(db, "s3", "p1", family_id="fam2", period=None, status="filed")

    res = c.get("/api/v1/blueprints/bp1/run-options")
    assert res.status_code == 200
    body = res.json()
    assert body["granularity"] == "month"
    assert [p["period"] for p in body["periods"]] == ["2026-06", "2026-05"]
    assert body["periods"][0]["families"][0] == {"key": "sales", "label": "Sales", "present": True}
    assert body["constants"] == [{"key": "roster", "label": "Roster", "present": True}]


# --- GET /blueprints/{id}/memories ------------------------------------------


def test_get_memories_both_scopes(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    _memory(db, "m1", "project note", "project", project_id="p1")
    _memory(db, "m2", "blueprint note", "blueprint", blueprint_id="bp1")
    _memory(db, "m3", "other proj", "project", project_id="p_other")

    res = c.get("/api/v1/blueprints/bp1/memories")
    assert res.status_code == 200
    ids = [m["id"] for m in res.json()["memories"]]
    # rowid DESC, both scopes for this blueprint/project only
    assert ids == ["m2", "m1"]


# --- GET /blueprints/{id}/copilot -------------------------------------------


def test_get_copilot_messages(client):
    c, db = client
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    db.execute(
        "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions, status) "
        "VALUES ('cm1', 'bp1', 'user', 'hi', NULL, 'ok')"
    )
    db.execute(
        "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions, status) "
        "VALUES ('cm2', 'bp1', 'assistant', 'hey', ?, 'ok')",
        (to_json([{"kind": "edit", "op": {"t": "x"}}]),),
    )
    res = c.get("/api/v1/blueprints/bp1/copilot")
    assert res.status_code == 200
    msgs = res.json()["messages"]
    assert msgs[0]["actions"] == []
    assert msgs[1]["actions"] == [{"kind": "edit", "op": {"t": "x"}}]


# --- GET /blueprints/{id}/goldens -------------------------------------------


def test_get_goldens(client):
    c, db = client
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00")
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name, bindings) "
        "VALUES ('g1', 'bp1', 'exemplar', 'Ex', '{\"raw\":1}')"
    )
    res = c.get("/api/v1/blueprints/bp1/goldens")
    assert res.status_code == 200
    goldens = res.json()["goldens"]
    assert len(goldens) == 1
    assert goldens[0]["id"] == "g1"
    # bindings stays a raw string
    assert goldens[0]["bindings"] == '{"raw":1}'


# --- GET /runs/{id} ---------------------------------------------------------


def test_get_run_404(client):
    c, db = client
    res = c.get("/api/v1/runs/nope")
    assert res.status_code == 404
    assert res.json() == {"error": "run not found"}


def test_get_run_payload(client):
    c, db = client
    _project(db, "p1", "Proj", "2026-07-01 00:00:00")
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00", current_rev=2)
    # pinned revision is rev 1 (the run's blueprint_rev), not current_rev 2
    content_rev1 = {
        "title": "Pinned",
        "eyebrow": "EB",
        "dateline": "DL",
        "sections": [
            {"key": "b", "number": 2, "heading": "B"},
            {"key": "a", "number": 1, "heading": "A"},
        ],
        "delivery": {"recipient": "x@y.com", "autoDeliverOnClear": True},
    }
    _revision(db, "rev1", "bp1", 1, content_rev1)
    _revision(db, "rev2", "bp1", 2, {"title": "Current", "sections": []})
    _family(db, "fam1", "p1", "sales", "Sales", "periodic", "month")
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES ('bp1', 'fam1')")

    doc = to_json({"title": "Prev doc", "sections": [{"key": "a"}]})
    _run(db, "r_prev", "bp1", created_at="2026-07-01 08:00:00", document=doc, status="complete")
    _run(db, "r1", "bp1", blueprint_rev=1, created_at="2026-07-01 09:00:00")

    db.execute(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES ('r1', 2, 't', ?)",
        (to_json({"n": 2}),),
    )
    db.execute(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES ('r1', 1, 't', ?)",
        (to_json({"n": 1}),),
    )
    db.execute(
        "INSERT INTO flags (id, run_id, code, section_key, question, options, status, resolution) "
        "VALUES ('f1', 'r1', 'C1', 'a', 'q?', ?, 'resolved', ?)",
        (to_json(["yes", "no"]), to_json({"option": "yes", "note": "ok"})),
    )
    _memory(db, "m1", "proj note", "project", project_id="p1")
    _memory(db, "m2", "bp note", "blueprint", blueprint_id="bp1")

    res = c.get("/api/v1/runs/r1")
    assert res.status_code == 200
    body = res.json()
    assert body["run"]["id"] == "r1"
    assert body["run"]["blueprintRev"] == 1
    # events ordered by seq
    assert [e["n"] for e in body["events"]] == [1, 2]
    # flags parsed
    assert body["flags"][0]["options"] == ["yes", "no"]
    assert body["flags"][0]["resolution"] == {"option": "yes", "note": "ok"}
    # sectionMeta sorted by number from pinned rev 1
    assert [s["key"] for s in body["sectionMeta"]] == ["a", "b"]
    assert body["sourceLabels"] == {"fam1": "Sales"}
    assert body["blueprint"] == {"id": "bp1", "name": "BP", "clientName": "Acme"}
    assert body["project"] == {"id": "p1", "name": "Proj"}
    assert body["content"]["title"] == "Pinned"
    assert body["content"]["delivery"] == {"recipient": "x@y.com", "autoDeliverOnClear": True}
    assert body["previous"]["runId"] == "r_prev"
    # memories both scopes, ordered rowid ASC
    assert [m["id"] for m in body["memories"]] == ["m1", "m2"]


def test_get_run_masthead_delivery_fallback(client):
    c, db = client
    _blueprint(db, "bp1", "p1", "BP", "2026-07-02 00:00:00", current_rev=1)
    _revision(
        db,
        "rev1",
        "bp1",
        1,
        {"title": "T", "eyebrow": "", "dateline": "", "sections": []},
    )
    _run(db, "r1", "bp1", blueprint_rev=1)
    res = c.get("/api/v1/runs/r1")
    assert res.status_code == 200
    assert res.json()["content"]["delivery"] == {"recipient": "", "autoDeliverOnClear": False}


def test_get_run_project_stub_when_missing(client):
    c, db = client
    _blueprint(db, "bp1", "gone", "BP", "2026-07-02 00:00:00", current_rev=1)
    _run(db, "r1", "bp1", blueprint_rev=1)
    res = c.get("/api/v1/runs/r1")
    assert res.status_code == 200
    assert res.json()["project"] == {"id": "gone", "name": ""}
