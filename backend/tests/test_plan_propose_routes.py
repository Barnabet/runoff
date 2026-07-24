"""Ports the deterministic plan-integration tests that exercise plan_propose.py
through the classify + replan routes:

  - apps/web/test/classifyPlan.test.ts  ("classify plan integration"): fresh
    proposal with preview/report attached + proposer-called-once; stored-plan fit
    with ZERO LLM calls; degenerate self-check retry with re-exec; proposer-null
    keeps a plan-less proposal.
  - apps/web/test/planIngest.test.ts  ("replan route"): 200 with the updated
    proposal; 500 `replan failed: no plan produced` leaving the proposal intact.

Both TS suites mock proposeParsePlan; here we monkeypatch
plan_propose.propose_parse_plan (and, for classify, sources.classify_source) so no
LLM is needed. load_grids / scan_tabular / execute_parse_plan / fit_parse_plan stay
real, running the mocked plans against on-disk openpyxl fixtures. This closes the
zero-execution gap on the stored/proposed/amended branches, fit→amend, the
degenerate retry re-exec, build_preview, and replan success/500.
"""

import io
import json

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from runoff_api.api import sources as sources_route
from runoff_api.core.jsonutil import to_json
from runoff_api.main import create_app
from runoff_api.services import plan_propose

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# A plan that cleanly parses the customer/amount fixture into one table.
GOOD_PLAN = {
    "version": 1,
    "tables": [
        {
            "name": "sales",
            "anchor": {"headerSignature": ["customer", "amount"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [],
            "columns": [
                {"from": "customer", "name": "customer", "type": "TEXT"},
                {"from": "amount", "name": "amount", "type": "INTEGER"},
            ],
            "onPeriodMismatch": "keep",
        }
    ],
}

# A structurally valid plan whose signature anchors nothing → degenerate.
BAD_PLAN = {
    "version": 1,
    "tables": [
        {
            "name": "sales",
            "anchor": {"headerSignature": ["zzz", "qqq"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [],
            "columns": [{"from": "zzz", "name": "z", "type": "TEXT"}],
            "onPeriodMismatch": "keep",
        }
    ],
}

# Replan revises the stored plan (adds a total-row exclude); planStatus → amended.
REVISED_PLAN = {
    "version": 1,
    "tables": [
        {
            "name": "sales",
            "anchor": {"headerSignature": ["customer", "amount"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [{"column": "customer", "pattern": "^total$"}],
            "columns": [
                {"from": "customer", "name": "customer", "type": "TEXT"},
                {"from": "amount", "name": "amount", "type": "INTEGER"},
            ],
            "onPeriodMismatch": "keep",
        }
    ],
}
STORED_PLAN = {**REVISED_PLAN, "tables": [{**REVISED_PLAN["tables"][0], "exclude": []}]}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    files = tmp_path / "files"
    files.mkdir()
    wh = tmp_path / "warehouses"
    wh.mkdir()
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh))
    # Both engine calls are monkeypatched per-test, so the client is never used.
    monkeypatch.setattr(sources_route, "make_llm_client", lambda: object())
    return {"files": files, "wh": wh}


@pytest.fixture()
def app_db(tmp_path, env):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        db = app.state.db
        db.execute("INSERT INTO projects (id, name) VALUES ('proj_1','P')")
        yield c, db


def _sales_bytes(rows=10):
    """customer/amount xlsx with `rows` data rows (10 → the 8-row preview truncates)."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Report Data"
    ws.append(["customer", "amount"])
    for i in range(1, rows + 1):
        ws.append([f"cust_{i}", i * 10])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _upload_sales(client, name="sales.xlsx"):
    res = client.post(
        "/api/v1/projects/proj_1/sources",
        files=[("files", (name, _sales_bytes(), XLSX_MIME))],
    )
    return res.json()["sources"][0]["id"]


def _classify(client, source_ids):
    return client.post("/api/v1/projects/proj_1/sources/classify", json={"sourceIds": source_ids})


def _proposals(returns):
    """A propose_parse_plan replacement returning scripted values, counting calls."""
    box = {"n": 0}

    def fake(**_kwargs):
        box["n"] += 1
        return returns[min(box["n"] - 1, len(returns) - 1)]

    fake.count = box
    return fake


def _classify_returns(value):
    def fake(*, client, filename, content_sample, families):
        return value

    return fake


def _stored(db, sid):
    return json.loads(db.execute("SELECT proposal FROM sources WHERE id = ?", (sid,)).fetchone()["proposal"])


# --- classify plan integration --------------------------------------------


def test_fresh_proposal_attaches_preview_report_proposer_called_once(app_db, env, monkeypatch):
    client, db = app_db
    src = _upload_sales(client)
    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _classify_returns(
            {
                "newFamily": {"key": "sales", "label": "Sales", "kind": "periodic", "granularity": "quarter"},
                "period": "2026-Q1",
                "confidence": "high",
            }
        ),
    )
    proposer = _proposals([GOOD_PLAN])
    monkeypatch.setattr(plan_propose, "propose_parse_plan", proposer)

    assert _classify(client, [src]).status_code == 200
    assert proposer.count["n"] == 1

    p = _stored(db, src)
    assert p["plan"] == GOOD_PLAN
    assert p["planStatus"] == "proposed"
    assert len(p["preview"]["tables"][0]["rows"]) <= 8
    assert p["report"]["tables"][0]["rowsKept"] == 10
    assert p["tables"] == [{"name": "fam_sales", "columns": ["customer", "amount"], "rowCount": 10}]


def test_stored_plan_fit_path_reuses_plan_zero_llm(app_db, env, monkeypatch):
    client, db = app_db
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity, parse_plan) "
        "VALUES ('fam_s','proj_1','sales','Sales','periodic','quarter',?)",
        (to_json(GOOD_PLAN),),
    )
    src = _upload_sales(client)
    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _classify_returns({"familyKey": "sales", "period": "2026-Q1", "confidence": "high"}),
    )
    proposer = _proposals([GOOD_PLAN])
    monkeypatch.setattr(plan_propose, "propose_parse_plan", proposer)

    assert _classify(client, [src]).status_code == 200
    assert proposer.count["n"] == 0  # stored-plan fit → zero LLM

    p = _stored(db, src)
    assert p["planStatus"] == "stored"
    assert p["plan"] == GOOD_PLAN
    assert p["report"]["tables"][0]["rowsKept"] == 10


def test_degenerate_first_plan_triggers_second_propose(app_db, env, monkeypatch):
    client, db = app_db
    src = _upload_sales(client)
    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _classify_returns(
            {
                "newFamily": {"key": "sales", "label": "Sales", "kind": "periodic", "granularity": "quarter"},
                "period": "2026-Q1",
                "confidence": "high",
            }
        ),
    )
    proposer = _proposals([BAD_PLAN, GOOD_PLAN])
    monkeypatch.setattr(plan_propose, "propose_parse_plan", proposer)

    assert _classify(client, [src]).status_code == 200
    assert proposer.count["n"] == 2

    p = _stored(db, src)
    assert p["planStatus"] == "proposed"
    assert p["plan"] == GOOD_PLAN
    assert p["report"]["tables"][0]["problems"] == []
    assert p["report"]["tables"][0]["rowsKept"] == 10


def test_proposer_null_keeps_plan_less_proposal(app_db, env, monkeypatch):
    client, db = app_db
    src = _upload_sales(client)
    monkeypatch.setattr(
        sources_route,
        "classify_source",
        _classify_returns(
            {
                "newFamily": {"key": "sales", "label": "Sales", "kind": "periodic", "granularity": "quarter"},
                "period": "2026-Q1",
                "confidence": "high",
            }
        ),
    )
    proposer = _proposals([None])
    monkeypatch.setattr(plan_propose, "propose_parse_plan", proposer)

    assert _classify(client, [src]).status_code == 200
    assert proposer.count["n"] >= 1

    p = _stored(db, src)
    assert "plan" not in p
    assert "planStatus" not in p
    assert "preview" not in p
    # The classify proposal itself is intact, with scan-based enrichment.
    assert p["newFamily"]["key"] == "sales"
    assert p["tables"] == [{"name": "fam_sales", "columns": ["customer", "amount"], "rowCount": 10}]


# --- replan route ----------------------------------------------------------


def _seed_sales_source(db, env):
    (env["files"] / "sales.xlsx").write_bytes(_sales_bytes(rows=2))
    db.execute(
        "INSERT INTO sources (id, project_id, name, stored_filename, mime, size, proposal) "
        "VALUES ('s1','proj_1','sales.xlsx','sales.xlsx',?,1,?)",
        (
            XLSX_MIME,
            to_json(
                {
                    "newFamily": {
                        "key": "sales", "label": "Sales", "kind": "periodic", "granularity": "quarter"
                    },
                    "period": "2026-Q1",
                    "plan": STORED_PLAN,
                    "planStatus": "proposed",
                }
            ),
        ),
    )


def test_replan_revises_plan_returns_200_with_updated_proposal(app_db, env, monkeypatch):
    client, db = app_db
    _seed_sales_source(db, env)
    monkeypatch.setattr(plan_propose, "propose_parse_plan", _proposals([REVISED_PLAN]))

    res = client.post(
        "/api/v1/projects/proj_1/sources/s1/replan", json={"feedback": "drop the total row"}
    )
    assert res.status_code == 200
    body = res.json()["proposal"]
    assert body["plan"] == REVISED_PLAN
    assert body["planStatus"] == "amended"
    assert _stored(db, "s1")["plan"] == REVISED_PLAN


def test_replan_500_no_plan_produced_leaves_proposal_intact(app_db, env, monkeypatch):
    client, db = app_db
    _seed_sales_source(db, env)
    monkeypatch.setattr(plan_propose, "propose_parse_plan", _proposals([None]))

    res = client.post("/api/v1/projects/proj_1/sources/s1/replan", json={"feedback": "nope"})
    assert res.status_code == 500
    assert res.json() == {"error": "replan failed: no plan produced"}
    assert _stored(db, "s1")["plan"] == STORED_PLAN  # unchanged
