"""Ports the "source manager routes" describe block of
apps/web/test/sourceManager.test.ts (deferred from Task 9), plus every documented
error path from docs/api/v1.md §2.3-2.7.

The six R2 handlers are driven through a real FastAPI TestClient against a temp
app DB + temp RUNOFF_FILES_DIR / RUNOFF_WAREHOUSE_DIR. Multipart uploads use real
small fixture files via TestClient `files=`.

LLM seams: classify_source is monkeypatched in the route module (the TS test mocks
classifySource the same way); make_llm_client is monkeypatched to a client that
makes propose_parse_plan fail, so plan_for_upload returns {"planStatus": "none"}
and enrichment falls back to the scan-based path (byte-identical to the TS suite,
whose getLlmClient returns `{}`). replan's LLM success path lands in Task 14; here
only its non-LLM error paths are covered.
"""

import json

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from runoff_api.api import sources as sources_route
from runoff_api.core.warehouse import (
    apply_schema,
    attach_warehouse,
    detach_warehouse,
    warehouse_path,
)
from runoff_api.main import create_app

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class _BrokenClient:
    """Stand-in LLM client whose access fails, so propose_parse_plan returns None
    (mirrors the TS getLlmClient mock returning `{}`)."""

    def __getattr__(self, _name):
        raise RuntimeError("no LLM in tests")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    files = tmp_path / "files"
    files.mkdir()
    wh = tmp_path / "warehouses"
    wh.mkdir()
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh))
    # Default seam: no real LLM. classify tests override classify_source per-case.
    monkeypatch.setattr(sources_route, "make_llm_client", lambda: _BrokenClient())
    return {"files": files, "wh": wh}


@pytest.fixture()
def app_db(tmp_path, env):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        db = app.state.db
        db.execute("INSERT INTO projects (id, name) VALUES ('proj_1','P')")
        yield c, db


def _upload(client, project_id, files):
    """POST multipart files (list of (field, (name, content, content_type)))."""
    return client.post(f"/api/v1/projects/{project_id}/sources", files=files)


def _csv(name, content, ct="text/csv"):
    return ("files", (name, content, ct))


def _stored_proposal(db, sid):
    raw = db.execute("SELECT proposal FROM sources WHERE id = ?", (sid,)).fetchone()["proposal"]
    return json.loads(raw)


def _make_xlsx(path, build):
    wb = Workbook()
    ws = wb.active
    ws.title = "Report Data"
    build(ws, wb)
    wb.save(path)


# --- POST /sources (multipart upload) -------------------------------------


def test_upload_stores_unfiled_row_and_writes_file(app_db, env):
    client, db = app_db
    res = _upload(client, "proj_1", [_csv("spend.csv", "a,b\n1,2\n")])
    assert res.status_code == 200
    sources = res.json()["sources"]
    assert len(sources) == 1
    assert sources[0]["status"] == "unfiled"
    assert sources[0]["id"].startswith("src_")
    row = dict(
        db.execute(
            "SELECT status, project_id AS projectId FROM sources WHERE id = ?", (sources[0]["id"],)
        ).fetchone()
    )
    assert row == {"status": "unfiled", "projectId": "proj_1"}
    assert (env["files"] / sources[0]["storedFilename"]).exists()


def test_upload_404_for_missing_project(app_db):
    client, _ = app_db
    res = _upload(client, "proj_none", [_csv("a.csv", "x")])
    assert res.status_code == 404
    assert res.json() == {"error": "project not found"}


def test_upload_400_expected_multipart_form_data(app_db):
    client, _ = app_db
    # A malformed multipart body: declared boundary, garbage payload.
    res = client.post(
        "/api/v1/projects/proj_1/sources",
        content=b"garbage-not-multipart",
        headers={"content-type": "multipart/form-data; boundary=----x"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": "expected multipart form data"}


def test_upload_400_expected_multipart_for_json_body(app_db):
    client, db = app_db
    # A JSON content-type is not a form body — TS `req.formData()` throws here.
    res = client.post("/api/v1/projects/proj_1/sources", json={"files": []})
    assert res.status_code == 400
    assert res.json() == {"error": "expected multipart form data"}
    assert db.execute("SELECT COUNT(*) AS n FROM sources").fetchone()["n"] == 0


def test_upload_400_files_are_required(app_db):
    client, db = app_db
    # A well-formed request with no `files` part.
    res = client.post("/api/v1/projects/proj_1/sources", files={"other": ("x.txt", "hi", "text/plain")})
    assert res.status_code == 400
    assert res.json() == {"error": "files are required"}
    assert db.execute("SELECT COUNT(*) AS n FROM sources").fetchone()["n"] == 0


def test_upload_413_over_limit_inserts_no_row(app_db, monkeypatch):
    client, db = app_db
    monkeypatch.setattr(sources_route, "MAX_UPLOAD_BYTES", 4)
    res = _upload(client, "proj_1", [_csv("huge.csv", "a,b\n1,2\n")])
    assert res.status_code == 413
    assert res.json() == {"error": "file exceeds 100MB limit"}
    assert db.execute("SELECT COUNT(*) AS n FROM sources").fetchone()["n"] == 0


# --- POST /sources/classify (LLM seam) ------------------------------------


def _proposal_stub(returns):
    """A classify_source replacement recording its kwargs (like classifyMock)."""
    calls = []

    def fake(*, client, filename, content_sample, families):
        calls.append({"filename": filename, "content_sample": content_sample, "families": families})
        val = returns.pop(0) if returns else None
        return val

    fake.calls = calls
    return fake


def test_classify_enriches_with_tables_skipped_and_drift(app_db, env, monkeypatch):
    client, db = app_db
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_s','proj_1','spend','Spend','periodic','quarter')"
    )
    attach_warehouse(db, "proj_1")
    apply_schema(
        db,
        True,
        [
            {
                "name": "fam_spend__report_data",
                "columns": [{"name": "campaign", "type": "TEXT"}, {"name": "budget", "type": "INTEGER"}],
            }
        ],
    )
    detach_warehouse(db)

    def build(ws, _wb):
        ws.append(["campaign", "spend"])
        ws.append(["brand", 100])
        ws.append([])
        ws.append(["Note: excludes agency fees"])
        ws.append([])
        ws.append(["region", "revenue"])
        ws.append(["emea", 900])

    up = _upload_xlsx(client, env, "messy.xlsx", build)
    src = up["id"]

    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _proposal_stub([{"familyKey": "spend", "period": "2026-Q1", "confidence": "high"}]),
    )
    res = client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": [src]})
    assert res.status_code == 200

    stored = _stored_proposal(db, src)
    assert stored["tables"] == [
        {"name": "fam_spend__report_data", "columns": ["campaign", "spend"], "rowCount": 1},
        {"name": "fam_spend__report_data_2", "columns": ["region", "revenue"], "rowCount": 1},
    ]
    assert stored["skippedFragments"] == 1
    assert len(stored["drift"]) > 0
    assert "new table: fam_spend__report_data_2" in stored["drift"]


def test_classify_from_content_sample_when_tabular_scan_fails(app_db, env, monkeypatch):
    client, db = app_db
    # .xlsx-named file (isTabular -> scanTabular attempted) holding non-xlsx bytes
    # with a pdf mime: the scan rejects, but readContentSample's pdf parser
    # degrades gracefully, so classify still runs. Proposal is non-null, un-enriched.
    up = _upload(client, "proj_1", [_csv("corrupt.xlsx", "not a real xlsx zip", "application/pdf")])
    src = up.json()["sources"][0]["id"]

    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _proposal_stub([{"familyKey": "trade_data", "period": "2026-Q1", "confidence": "high"}]),
    )
    res = client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": [src]})
    assert res.status_code == 200

    proposal = _stored_proposal(db, src)
    assert "tables" not in proposal
    assert "skippedFragments" not in proposal
    assert "drift" not in proposal


def test_classify_corrupt_tabular_real_mime_from_raw_bytes(app_db, env, monkeypatch):
    client, db = app_db
    # Genuine xlsx mime carrying non-xlsx bytes: scanTabular rejects, buildSourcePack
    # skips csv/xlsx so the pack sample is empty -> fallback reads raw file bytes so
    # the classifier sees real text rather than only the filename.
    up = _upload(client, "proj_1", [_csv("corrupt.xlsx", "channel,amount\nsearch,120050\n", XLSX_MIME)])
    src = up.json()["sources"][0]["id"]

    stub = _proposal_stub([{"familyKey": "trade_data", "period": "2026-Q1", "confidence": "high"}])
    monkeypatch.setattr(sources_route, "classify_source", stub)
    res = client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": [src]})
    assert res.status_code == 200

    assert db.execute("SELECT proposal FROM sources WHERE id = ?", (src,)).fetchone()["proposal"] is not None
    sample = stub.calls[0]["content_sample"]
    assert len(sample) > 0
    assert "channel,amount" in sample


def test_classify_keeps_unenriched_proposal_when_enrichment_throws(app_db, env, monkeypatch):
    client, db = app_db
    up = _upload(client, "proj_1", [_csv("ok.csv", "a,b\n1,2\n")])
    src = up.json()["sources"][0]["id"]

    # Valid CSV ⇒ scan succeeds and enrichment runs. Corrupt the warehouse file so
    # read_warehouse_tables throws when it opens it: the throw must be isolated,
    # leaving the valid un-enriched proposal intact.
    warehouse_path("proj_1")
    (env["wh"] / "proj_1.db").write_text("not a sqlite database")

    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _proposal_stub([{"familyKey": "trade_data", "period": "2026-Q1", "confidence": "high"}]),
    )
    res = client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": [src]})
    assert res.status_code == 200

    proposal = _stored_proposal(db, src)
    assert proposal.get("familyKey") is not None
    assert "tables" not in proposal


def test_classify_persists_proposal_and_null_when_mock_returns_null(app_db, env, monkeypatch):
    client, db = app_db
    up = _upload(
        client,
        "proj_1",
        [_csv("one.csv", "a,b\n1,2\n"), _csv("two.csv", "c,d\n3,4\n")],
    )
    s1, s2 = [s["id"] for s in up.json()["sources"]]

    proposal = {"familyKey": "trade_data", "period": "2026-Q1", "confidence": "high"}
    stub = _proposal_stub([dict(proposal), None])
    monkeypatch.setattr(sources_route, "classify_source", stub)

    res = client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": [s1, s2]})
    assert res.status_code == 200
    assert len(stub.calls) == 2

    r1 = _stored_proposal(db, s1)
    # one.csv is tabular, so the stored proposal is enriched from the scan: a single
    # table (no warehouse yet -> empty drift, no skipped fragments).
    assert r1 == {
        **proposal,
        "tables": [{"name": "fam_trade_data", "columns": ["a", "b"], "rowCount": 1}],
        "skippedFragments": 0,
        "drift": [],
    }
    assert db.execute("SELECT proposal FROM sources WHERE id = ?", (s2,)).fetchone()["proposal"] is None


def test_classify_404_for_missing_project(app_db):
    client, _ = app_db
    res = client.post("/api/v1/projects/proj_none/sources/classify", json={"sourceIds": []})
    assert res.status_code == 404
    assert res.json() == {"error": "project not found"}


def test_classify_400_invalid_json_body(app_db):
    client, _ = app_db
    res = client.post(
        "/api/v1/projects/proj_1/sources/classify",
        content=b"not json",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}


# --- POST /sources/confirm + DELETE/PATCH ---------------------------------


def test_confirm_rejects_invalid_period_mismatch(app_db):
    client, _ = app_db
    res = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        json={"sourceId": "whatever", "periodMismatch": "foo"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": 'periodMismatch must be "keep" or "exclude"'}


def test_confirm_rejects_explicit_null_period_mismatch(app_db):
    client, _ = app_db
    # An explicit JSON `null` is present (not absent) → 400, matching TS's
    # `body.periodMismatch !== undefined` presence check.
    res = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        json={"sourceId": "whatever", "periodMismatch": None},
    )
    assert res.status_code == 400
    assert res.json() == {"error": 'periodMismatch must be "keep" or "exclude"'}


def test_confirm_400_invalid_json_body(app_db):
    client, _ = app_db
    res = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        content=b"{bad",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}


def test_confirm_400_source_id_required(app_db):
    client, _ = app_db
    res = client.post("/api/v1/projects/proj_1/sources/confirm", json={"period": None})
    assert res.status_code == 400
    assert res.json() == {"error": "sourceId is required"}


def test_confirm_passes_through_file_source_error(app_db):
    client, _ = app_db
    # A non-existent source: fileSource returns {status:404, error:"source not found"}.
    res = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        json={"sourceId": "src_missing", "familyId": "fam_x", "period": "2026-Q1"},
    )
    assert res.status_code == 404
    assert res.json() == {"error": "source not found"}


def test_confirm_files_source_then_delete_frees_slot(app_db, env):
    client, db = app_db
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')"
    )
    up = _upload(client, "proj_1", [_csv("a.csv", "a,b\n1,2\n")])
    src = up.json()["sources"][0]
    stored = src["storedFilename"]

    ok = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        json={"sourceId": src["id"], "familyId": "fam_q", "period": "2026-Q1"},
    )
    assert ok.status_code == 200
    assert dict(db.execute("SELECT status FROM sources WHERE id = ?", (src["id"],)).fetchone()) == {
        "status": "filed"
    }

    dele = client.delete(f"/api/v1/projects/proj_1/sources/{src['id']}")
    assert dele.status_code == 200
    assert db.execute("SELECT id FROM sources WHERE id = ?", (src["id"],)).fetchone() is None
    assert not (env["files"] / stored).exists()

    # Slot is free: a new source can take 2026-Q1.
    up2 = _upload(client, "proj_1", [_csv("b.csv", "a,b\n3,4\n")])
    s2 = up2.json()["sources"][0]["id"]
    ok2 = client.post(
        "/api/v1/projects/proj_1/sources/confirm",
        json={"sourceId": s2, "familyId": "fam_q", "period": "2026-Q1"},
    )
    assert ok2.status_code == 200


def test_patch_refiles_into_different_slot(app_db, env):
    client, db = app_db
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')"
    )
    up = _upload(client, "proj_1", [_csv("a.csv", "a,b\n1,2\n")])
    src = up.json()["sources"][0]["id"]

    res = client.patch(
        f"/api/v1/projects/proj_1/sources/{src}", json={"familyId": "fam_q", "period": "2026-Q2"}
    )
    assert res.status_code == 200
    assert dict(db.execute("SELECT period, status FROM sources WHERE id = ?", (src,)).fetchone()) == {
        "period": "2026-Q2",
        "status": "filed",
    }


def test_patch_400_invalid_json_body(app_db):
    client, _ = app_db
    res = client.patch(
        "/api/v1/projects/proj_1/sources/src_x",
        content=b"{bad",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}


def test_delete_404_for_missing_source(app_db):
    client, _ = app_db
    res = client.delete("/api/v1/projects/proj_1/sources/src_none")
    assert res.status_code == 404
    assert res.json() == {"error": "source not found"}


def test_delete_refuses_replaced_row(app_db, env):
    client, db = app_db
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')"
    )
    up = _upload(
        client, "proj_1", [_csv("a.csv", "a,b\n1,2\n"), _csv("b.csv", "a,b\n3,4\n")]
    )
    ids = [s["id"] for s in up.json()["sources"]]
    for sid in ids:
        client.post(
            "/api/v1/projects/proj_1/sources/confirm",
            json={"sourceId": sid, "familyId": "fam_q", "period": "2026-Q1"},
        )
    # ids[0] is now 'replaced'.
    res = client.delete(f"/api/v1/projects/proj_1/sources/{ids[0]}")
    assert res.status_code == 400
    assert res.json() == {"error": "replaced sources cannot be deleted"}


# --- POST /sources/:sourceId/replan (non-LLM error paths; LLM in Task 14) ---


def test_replan_400_invalid_json_body(app_db):
    client, _ = app_db
    res = client.post(
        "/api/v1/projects/proj_1/sources/src_x/replan",
        content=b"{bad",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}


def test_replan_400_feedback_required(app_db):
    client, _ = app_db
    res = client.post("/api/v1/projects/proj_1/sources/src_x/replan", json={"feedback": "   "})
    assert res.status_code == 400
    assert res.json() == {"error": "feedback is required"}


def test_replan_404_source_not_found(app_db):
    client, _ = app_db
    res = client.post("/api/v1/projects/proj_1/sources/src_none/replan", json={"feedback": "tweak it"})
    assert res.status_code == 404
    assert res.json() == {"error": "source not found"}


def test_replan_400_source_has_no_plan_proposal(app_db, env):
    client, db = app_db
    up = _upload(client, "proj_1", [_csv("a.csv", "a,b\n1,2\n")])
    src = up.json()["sources"][0]["id"]
    # No proposal stored yet -> 400.
    res = client.post(
        f"/api/v1/projects/proj_1/sources/{src}/replan", json={"feedback": "tweak it"}
    )
    assert res.status_code == 400
    assert res.json() == {"error": "source has no plan proposal"}


# --- shared helper ---------------------------------------------------------


def _upload_xlsx(client, env, name, build):
    path = env["files"] / name
    _make_xlsx(path, build)
    with open(path, "rb") as fh:
        data = fh.read()
    res = client.post(
        "/api/v1/projects/proj_1/sources",
        files=[("files", (name, data, XLSX_MIME))],
    )
    return res.json()["sources"][0]
