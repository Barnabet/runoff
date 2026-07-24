"""Ports apps/web/test/goldenRoutes.test.ts (the bind + unify describe blocks)
plus the R3 multipart exemplar-upload variant of POST /blueprints/:id/goldens
(§2.14 multipart, §2.15 unify, §2.16 bind).

The LLM boundary is mocked at the Task 6 seams: `unify_and_bind_exemplar` and
`bind_exemplar` are monkeypatched in the route module's namespace. The deterministic
R1 seams (`rebuild_run_golden_inventory`, `verify_stored_inventory`) are likewise
spied so the route-dispatch arms can be asserted without seeding a warehouse — the
real behavior of those functions is covered by test_api_writes.py / test_golden_pipeline.py.

The PATCH-period cases from the TS suite (`invalid period`, `null period`, `404`)
are already twinned in test_api_writes.py (test_patch_golden_*); only the adjacent
R1-parity fix (trailing-newline period) is added here as a regression.
"""

import pytest
from fastapi.testclient import TestClient

from runoff_api.api import goldens as goldens_route
from runoff_api.main import create_app


class _Spy:
    """Records positional/keyword calls; returns a configurable value and can run a
    side effect (used to snapshot DB state at call time)."""

    def __init__(self, ret=None):
        self.calls = []
        self.ret = ret
        self.side_effect = None

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.side_effect is not None:
            self.side_effect(*args, **kwargs)
        return self.ret

    @property
    def called(self) -> bool:
        return len(self.calls) > 0


@pytest.fixture()
def env(tmp_path, monkeypatch):
    files = tmp_path / "files"
    files.mkdir()
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    return {"files": files}


@pytest.fixture()
def seams(monkeypatch):
    """Default: every service seam is a no-op spy. Cases reconfigure return values."""
    spies = {
        "unify_and_bind_exemplar": _Spy(),
        "bind_exemplar": _Spy({"ok": True}),
        "rebuild_run_golden_inventory": _Spy(),
        "verify_stored_inventory": _Spy(),
    }
    for name, spy in spies.items():
        monkeypatch.setattr(goldens_route, name, spy)
    return spies


@pytest.fixture()
def app_db(tmp_path, env, seams):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        db = app.state.db
        db.execute("INSERT INTO blueprints (id, name, project_id) VALUES ('bp_1','R','proj_1')")
        yield c, db, seams


def _insert_exemplar(db, gid, **over):
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name, mime, stored_filename, period, "
        "document, bindings, unify_error) VALUES (?, 'bp_1', 'exemplar', ?, ?, ?, ?, ?, ?, ?)",
        (
            gid,
            over.get("name", "x.md"),
            over.get("mime", "text/markdown"),
            over.get("stored_filename"),
            over.get("period"),
            over.get("document"),
            over.get("bindings"),
            over.get("unify_error"),
        ),
    )


def _insert_run_golden(db, gid, **over):
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, run_id, period) VALUES (?, 'bp_1', 'run', ?, ?)",
        (gid, over.get("run_id", "run_1"), over.get("period")),
    )


# --- POST /blueprints/:id/goldens — multipart exemplar upload (§2.14 R3) ------


def test_multipart_happy_path_stores_row_and_runs_pipeline(app_db, env):
    c, db, seams = app_db

    # The pipeline seam must see a fully-inserted exemplar row (synchronous, post-INSERT).
    seen = {}

    def capture(passed_db, golden_id):
        row = passed_db.execute(
            "SELECT kind, name, mime, stored_filename AS sf FROM goldens WHERE id = ?", (golden_id,)
        ).fetchone()
        seen["row"] = dict(row) if row else None

    seams["unify_and_bind_exemplar"].side_effect = capture

    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("report.md", b"# Q1\nRevenue was $150", "text/markdown")},
    )
    assert res.status_code == 200
    gid = res.json()["id"]
    assert gid.startswith("gold_")

    row = db.execute(
        "SELECT kind, name, mime, stored_filename AS sf, note FROM goldens WHERE id = ?", (gid,)
    ).fetchone()
    assert row["kind"] == "exemplar"
    assert row["name"] == "report.md"  # no name field → filename fallback
    assert row["mime"] == "text/markdown"
    assert row["sf"] == f"{gid}_report.md"
    assert row["note"] is None
    # File bytes landed under RUNOFF_FILES_DIR as {goldenId}_{sanitized}.
    stored = env["files"] / f"{gid}_report.md"
    assert stored.read_bytes() == b"# Q1\nRevenue was $150"
    # Pipeline ran synchronously AFTER the INSERT (saw the committed row).
    assert seen["row"] == {
        "kind": "exemplar",
        "name": "report.md",
        "mime": "text/markdown",
        "sf": f"{gid}_report.md",
    }


def test_multipart_missing_file_400(app_db):
    c, _, seams = app_db
    # Multipart content-type (httpx sends it because files= is present) but no `file` part.
    res = c.post("/api/v1/blueprints/bp_1/goldens", files={"notfile": ("a.txt", b"x", "text/plain")})
    assert res.status_code == 400
    assert res.json() == {"error": "file is required"}
    assert not seams["unify_and_bind_exemplar"].called


def test_multipart_name_and_note_trimmed(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("orig.md", b"x", "text/markdown")},
        data={"name": "  My Name  ", "note": "  a note  "},
    )
    gid = res.json()["id"]
    row = db.execute("SELECT name, note FROM goldens WHERE id = ?", (gid,)).fetchone()
    assert row["name"] == "My Name"
    assert row["note"] == "a note"


def test_multipart_blank_name_falls_back_to_filename_and_blank_note_none(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("origname.md", b"x", "text/markdown")},
        data={"name": "   ", "note": "   "},
    )
    gid = res.json()["id"]
    row = db.execute("SELECT name, note FROM goldens WHERE id = ?", (gid,)).fetchone()
    assert row["name"] == "origname.md"
    assert row["note"] is None


def test_multipart_mime_declared_used_when_meaningful(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("x.bin", b"x", "text/markdown")},  # declared, not octet-stream
    )
    gid = res.json()["id"]
    assert db.execute("SELECT mime FROM goldens WHERE id = ?", (gid,)).fetchone()["mime"] == "text/markdown"


def test_multipart_mime_ext_fallback_when_octet_stream(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("report.pdf", b"%PDF", "application/octet-stream")},
    )
    gid = res.json()["id"]
    assert db.execute("SELECT mime FROM goldens WHERE id = ?", (gid,)).fetchone()["mime"] == "application/pdf"


def test_multipart_mime_ext_fallback_docx(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("memo.docx", b"PK", "application/octet-stream")},
    )
    gid = res.json()["id"]
    assert (
        db.execute("SELECT mime FROM goldens WHERE id = ?", (gid,)).fetchone()["mime"]
        == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


def test_multipart_mime_unknown_ext_defaults_octet_stream(app_db):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("data.weird", b"x", "application/octet-stream")},
    )
    gid = res.json()["id"]
    assert (
        db.execute("SELECT mime FROM goldens WHERE id = ?", (gid,)).fetchone()["mime"]
        == "application/octet-stream"
    )


def test_multipart_sanitizes_stored_filename(app_db, env):
    c, db, _ = app_db
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens",
        files={"file": ("my report (final)!.md", b"x", "text/markdown")},
    )
    gid = res.json()["id"]
    sf = db.execute("SELECT stored_filename AS sf FROM goldens WHERE id = ?", (gid,)).fetchone()["sf"]
    assert sf == f"{gid}_my_report__final__.md"
    assert (env["files"] / sf).exists()


def test_sanitize_name_helper_empty_falls_back_to_file():
    assert goldens_route._sanitize_name("") == "file"
    assert goldens_route._sanitize_name("/tmp/../") == "file"
    assert goldens_route._sanitize_name("a/b/c.md") == "c.md"


# --- POST /blueprints/:id/goldens/:goldenId/unify (§2.15) ---------------------


def test_unify_404_unknown_golden(app_db):
    c, _, seams = app_db
    res = c.post("/api/v1/blueprints/bp_1/goldens/nope/unify")
    assert res.status_code == 404
    assert res.json() == {"error": "golden not found"}
    assert not seams["unify_and_bind_exemplar"].called


def test_unify_404_wrong_blueprint(app_db):
    c, db, _ = app_db
    _insert_exemplar(db, "gold_x")
    res = c.post("/api/v1/blueprints/bp_other/goldens/gold_x/unify")
    assert res.status_code == 404
    assert res.json() == {"error": "golden not found"}


def test_unify_400_non_exemplar(app_db):
    c, db, seams = app_db
    _insert_run_golden(db, "gold_run")
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_run/unify")
    assert res.status_code == 400
    assert res.json() == {"error": "only exemplar goldens can be unified"}
    assert not seams["unify_and_bind_exemplar"].called


def test_unify_success_runs_pipeline_and_returns_row(app_db):
    c, db, seams = app_db
    _insert_exemplar(db, "gold_e", document='{"title":"T","sections":[]}', period="2026-Q1")
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_e/unify")
    assert res.status_code == 200
    assert seams["unify_and_bind_exemplar"].calls[0][0] == (db, "gold_e")
    body = res.json()
    assert body["golden"]["id"] == "gold_e"
    assert body["golden"]["kind"] == "exemplar"


# --- POST /blueprints/:id/goldens/:goldenId/bind (§2.16) ---------------------


def test_bind_404_unknown_golden(app_db):
    c, _, _ = app_db
    res = c.post("/api/v1/blueprints/bp_1/goldens/nope/bind", json={})
    assert res.status_code == 404
    assert res.json() == {"error": "golden not found"}


def test_bind_404_wrong_blueprint(app_db):
    c, db, _ = app_db
    _insert_exemplar(db, "gold_x", document='{"title":"T","sections":[]}')
    res = c.post("/api/v1/blueprints/bp_other/goldens/gold_x/bind", json={})
    assert res.status_code == 404


def test_bind_run_golden_with_feedback_400(app_db):
    c, db, seams = app_db
    _insert_run_golden(db, "gold_r")
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_r/bind", json={"feedback": "do x"})
    assert res.status_code == 400
    assert res.json() == {"error": "feedback requires an exemplar golden"}
    assert not seams["rebuild_run_golden_inventory"].called
    assert not seams["bind_exemplar"].called


def test_bind_run_golden_no_feedback_rebuilds(app_db):
    c, db, seams = app_db
    _insert_run_golden(db, "gold_r")
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_r/bind", json={})
    assert res.status_code == 200
    assert seams["rebuild_run_golden_inventory"].calls[0][0] == (db, "gold_r")
    assert not seams["bind_exemplar"].called
    assert res.json()["golden"]["id"] == "gold_r"


def test_bind_parse_failure_swallowed_to_no_feedback(app_db):
    c, db, seams = app_db
    # A run golden: an empty feedback path must reach rebuild, not the 400 arm.
    _insert_run_golden(db, "gold_r")
    res = c.post(
        "/api/v1/blueprints/bp_1/goldens/gold_r/bind",
        content=b"not json at all",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 200  # parse failure → feedback None → rebuild, not 400
    assert seams["rebuild_run_golden_inventory"].called


def test_bind_empty_string_feedback_treated_as_none(app_db):
    c, db, seams = app_db
    _insert_run_golden(db, "gold_r")
    # feedback "" is falsy → not "feedback requires an exemplar golden"; rebuild runs.
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_r/bind", json={"feedback": ""})
    assert res.status_code == 200
    assert seams["rebuild_run_golden_inventory"].called


def test_bind_exemplar_not_unified_400(app_db):
    c, db, seams = app_db
    _insert_exemplar(db, "gold_u", unify_error="unify failed: no document produced")
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_u/bind", json={})
    assert res.status_code == 400
    assert res.json() == {"error": "golden is not unified"}
    assert not seams["bind_exemplar"].called
    assert not seams["verify_stored_inventory"].called


def test_bind_exemplar_bound_no_feedback_verifies_only(app_db):
    c, db, seams = app_db
    _insert_exemplar(
        db, "gold_v", document='{"title":"T","sections":[]}', bindings='{"version":1,"items":[]}'
    )
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_v/bind", json={})
    assert res.status_code == 200
    assert seams["verify_stored_inventory"].calls[0][0] == (db, "gold_v")
    assert not seams["bind_exemplar"].called  # no LLM seam touched
    assert res.json()["golden"]["id"] == "gold_v"


def test_bind_exemplar_with_feedback_calls_agent(app_db):
    c, db, seams = app_db
    _insert_exemplar(
        db, "gold_f", document='{"title":"T","sections":[]}', bindings='{"version":1,"items":[]}'
    )
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_f/bind", json={"feedback": "bind revenue"})
    assert res.status_code == 200
    args, kwargs = seams["bind_exemplar"].calls[0]
    assert args == (db, "gold_f")
    assert kwargs == {"feedback": "bind revenue"}
    assert not seams["verify_stored_inventory"].called


def test_bind_exemplar_unified_no_bindings_calls_agent(app_db):
    c, db, seams = app_db
    # Unified but never bound (bindings NULL) + no feedback → falls through to bind_exemplar.
    _insert_exemplar(db, "gold_b", document='{"title":"T","sections":[]}')
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_b/bind", json={})
    assert res.status_code == 200
    assert seams["bind_exemplar"].calls[0][1] == {"feedback": None}
    assert not seams["verify_stored_inventory"].called


def test_bind_exemplar_agent_failure_500(app_db):
    c, db, seams = app_db
    seams["bind_exemplar"].ret = {"ok": False, "error": "bind failed: no inventory produced"}
    _insert_exemplar(db, "gold_f", document='{"title":"T","sections":[]}')
    res = c.post("/api/v1/blueprints/bp_1/goldens/gold_f/bind", json={"feedback": "x"})
    assert res.status_code == 500
    assert res.json() == {"error": "bind failed: no inventory produced"}


# --- adjacent R1-parity fix: trailing-newline period on PATCH ----------------


def test_patch_period_rejects_trailing_newline(app_db):
    c, db, _ = app_db
    _insert_run_golden(db, "gold_p")
    res = c.patch("/api/v1/goldens/gold_p", json={"period": "2026-Q1\n"})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid period: 2026-Q1\n"}
