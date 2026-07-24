"""Contract tests for POST /api/v1/blueprints/{id}/copilot (docs/api/v1.md §2.13 + §3.2).

The copilot stream is self-terminating (exactly one done/error frame, then close),
so a TestClient reading the whole HTTP body back exercises the real StreamingResponse
wiring. The engine seam (``copilot_turn``) is monkeypatched at the api module namespace
for deterministic streams — the worker thread looks the name up as a module global at
call time, so the patch takes effect on the thread. Reads run on a watchdog reader
thread (Task 1 pattern) so a broken stream fails the test instead of hanging the suite.
"""

import json
import threading

import pytest
from fastapi.testclient import TestClient

from runoff_api.api import blueprints as bp_route
from runoff_api.core.jsonutil import to_json
from runoff_api.main import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        db = app.state.db
        _seed(db, "bp_1")
        yield c, db


# --- seed --------------------------------------------------------------------

DRAFT = {
    "title": "Report",
    "clientName": "Client",
    "eyebrow": "EB",
    "dateline": "June 2026",
    "sections": [
        {
            "key": "a", "number": 1, "heading": "A", "mode": "auto",
            "instruction": "about a", "familyIds": [], "queries": [], "rules": [],
        },
        {
            "key": "b", "number": 2, "heading": "B", "mode": "auto",
            "instruction": "about b", "familyIds": [], "queries": [], "rules": [],
        },
    ],
    "globalRules": ["be brief"],
    "delivery": {"recipient": "x@y.z", "autoDeliverOnClear": False},
}


def _seed(db, bid):
    db.execute(
        "INSERT INTO projects (id, name) VALUES ('proj_1', 'Proj')"
    )
    db.execute(
        "INSERT INTO blueprints (id, name, client_name, project_id, current_rev) "
        "VALUES (?, 'R', 'C', 'proj_1', 1)",
        (bid,),
    )
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)",
        (f"rev_{bid}", bid, to_json(DRAFT)),
    )


# --- watchdog stream reader --------------------------------------------------


def _join_or_fail(fn, timeout, message):
    box: dict = {}

    def worker():
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 — re-raised on the main thread
            box["error"] = exc

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        pytest.fail(message)
    if "error" in box:
        raise box["error"]
    return box["result"]


def _post_stream(client, url, payload, timeout=3.0):
    """POST a JSON body and read the whole (self-terminating) SSE body back."""

    def read():
        with client.stream("POST", url, json=payload) as r:
            return dict(r.headers), b"".join(r.iter_raw())

    return _join_or_fail(read, timeout, f"copilot stream {url} did not terminate within {timeout}s")


def _events(data: bytes) -> list[dict]:
    frames = [f for f in data.decode().split("\n\n") if f]
    return [json.loads(f[len("data: ") :]) for f in frames]


# --- (1) success: streams events in order, persists both messages ------------


def test_post_streams_events_and_persists_messages(client, monkeypatch):
    c, db = client

    edit_op = {"type": "update_global_rules", "before": [], "after": ["x"]}

    def fake_turn(**opts):
        opts["io"].emit({"type": "text_delta", "text": "Hello"})
        opts["io"].emit({"type": "edit", "op": edit_op})
        return {"reply": "Hello", "actions": [{"kind": "edit", "op": edit_op}], "draft": DRAFT}

    monkeypatch.setattr(bp_route, "copilot_turn", fake_turn)

    headers, data = _post_stream(
        c, "/api/v1/blueprints/bp_1/copilot", {"message": "hi", "draft": DRAFT, "selectedKey": None}
    )

    assert headers["content-type"].startswith("text/event-stream")
    assert headers["cache-control"] == "no-cache"
    assert headers["connection"] == "keep-alive"

    events = _events(data)
    assert [e["type"] for e in events] == ["text_delta", "edit", "done"]
    # Frames are exactly `data: <compact json>\n\n`.
    assert data.startswith(b'data: {"type":"text_delta","text":"Hello"}\n\n')

    rows = db.execute(
        "SELECT id, role, body, actions, status FROM copilot_messages "
        "WHERE blueprint_id='bp_1' ORDER BY rowid"
    ).fetchall()
    assert [(r["role"], r["body"], r["status"]) for r in rows] == [
        ("user", "hi", "ok"),
        ("assistant", "Hello", "ok"),
    ]
    # done carries the persisted assistant row id; actions are stored as JSON.
    assert events[-1]["messageId"] == rows[1]["id"]
    assert json.loads(rows[1]["actions"]) == [{"kind": "edit", "op": edit_op}]


# --- (2) pre-stream 400s are JSON, not SSE -----------------------------------


def test_invalid_json_body_400(client, monkeypatch):
    c, _ = client
    called = []
    monkeypatch.setattr(bp_route, "copilot_turn", lambda **o: called.append(o))
    res = c.post("/api/v1/blueprints/bp_1/copilot", content=b"{not json")
    assert res.status_code == 400
    assert res.json() == {"error": "invalid JSON body"}
    assert "text/event-stream" not in res.headers.get("content-type", "")
    assert called == []


@pytest.mark.parametrize("payload", [
    {"draft": DRAFT},                       # missing
    {"message": 123, "draft": DRAFT},       # non-string
    {"message": "   ", "draft": DRAFT},     # whitespace-only
])
def test_message_required_400(client, monkeypatch, payload):
    c, _ = client
    called = []
    monkeypatch.setattr(bp_route, "copilot_turn", lambda **o: called.append(o))
    res = c.post("/api/v1/blueprints/bp_1/copilot", json=payload)
    assert res.status_code == 400
    assert res.json() == {"error": "message is required"}
    assert called == []


def test_invalid_draft_400_before_engine(client, monkeypatch):
    c, _ = client
    called = []
    monkeypatch.setattr(bp_route, "copilot_turn", lambda **o: called.append(o))
    res = c.post("/api/v1/blueprints/bp_1/copilot", json={"message": "hi", "draft": {"junk": True}})
    assert res.status_code == 400
    assert res.json() == {"error": "invalid draft"}
    assert called == []


# --- (3) selectedKey / thread loaded before the user insert ------------------


def test_selected_key_non_string_becomes_none_and_thread_excludes_new_message(client, monkeypatch):
    c, db = client
    # Pre-seed a prior ok turn plus one non-ok row (must not reach the engine).
    ins = "INSERT INTO copilot_messages (id, blueprint_id, role, body) VALUES (?, 'bp_1', ?, ?)"
    db.execute(ins, ("cm_u", "user", "earlier"))
    db.execute(ins, ("cm_a", "assistant", "reply"))
    db.execute(
        "INSERT INTO copilot_messages (id, blueprint_id, role, body, status) "
        "VALUES ('cm_f', 'bp_1', 'assistant', 'failed one', 'failed')"
    )

    seen: dict = {}

    def fake_turn(**opts):
        seen.update(opts)
        return {"reply": "ok", "actions": [], "draft": DRAFT}

    monkeypatch.setattr(bp_route, "copilot_turn", fake_turn)

    _post_stream(
        c, "/api/v1/blueprints/bp_1/copilot", {"message": "now", "draft": DRAFT, "selectedKey": 42}
    )

    assert seen["selected_key"] is None
    # Thread is the prior ok rows in rowid order — NOT the just-posted "now",
    # and NOT the failed row.
    assert seen["thread"] == [
        {"role": "user", "body": "earlier"},
        {"role": "assistant", "body": "reply"},
    ]
    # The new user row was inserted with a cmsg id.
    row = db.execute("SELECT id FROM copilot_messages WHERE body='now'").fetchone()
    assert row["id"].startswith("cmsg_")


# --- (4) golden + scaffold caches reach build_copilot_context ----------------


def test_caches_built_from_resolvable_goldens(client, monkeypatch):
    c, db = client
    doc = {
        "title": "T", "eyebrow": "E", "dateline": "D",
        "sections": [{"key": "overview", "heading": "Overview",
                      "blocks": [{"type": "paragraph", "spans": [{"text": "Total $150"}]}]}],
    }
    inventory = {
        "version": 1,
        "items": [{
            "id": "total", "kind": "value",
            "anchor": {"sectionKey": "overview", "blockIndex": 0, "spanIndex": 0},
            "raw": "$150", "parsed": 150, "reason": None,
            "binding": {"familyId": "fam_x",
                        "sql": "SELECT SUM(amount) FROM fam_x WHERE _period = :period",
                        "verifiedValue": 150, "status": "bound"},
        }],
    }
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name, period, document, bindings) "
        "VALUES ('g_ok', 'bp_1', 'exemplar', 'OK exemplar', '2026-Q1', ?, ?)",
        (to_json(doc), to_json(inventory)),
    )
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name, unify_error) "
        "VALUES ('g_skip', 'bp_1', 'exemplar', 'Skip me', 'boom')"
    )

    from runoff_api.services.goldens import resolve_golden as real_resolve

    def resolve_skipping_g_skip(dbc, gid):
        return None if gid == "g_skip" else real_resolve(dbc, gid)

    monkeypatch.setattr(bp_route, "resolve_golden", resolve_skipping_g_skip)

    captured: dict = {}
    real_build = bp_route.build_copilot_context

    def spy_build(dbc, bid, golden_cache, scaffold_cache):
        captured["golden"] = golden_cache
        captured["scaffold"] = scaffold_cache
        return real_build(dbc, bid, golden_cache, scaffold_cache)

    monkeypatch.setattr(bp_route, "build_copilot_context", spy_build)
    monkeypatch.setattr(bp_route, "copilot_turn", lambda **o: {"reply": "ok", "actions": [], "draft": DRAFT})

    _post_stream(c, "/api/v1/blueprints/bp_1/copilot", {"message": "hi", "draft": DRAFT})

    # g_skip resolved to None → skipped from both caches.
    assert set(captured["golden"]) == {"g_ok"}
    assert set(captured["scaffold"]) == {"g_ok"}
    entry = captured["golden"]["g_ok"]
    assert entry["description"] == "OK exemplar — 1/1 bound, 0 mismatch, 0 unbound"
    assert "$150" in entry["text"]
    assert "SCAFFOLD DIGEST" in captured["scaffold"]["g_ok"]


# --- (5) mid-turn error persists a failed row + terminal error event ---------


def test_mid_stream_error_persists_failed_row(client, monkeypatch):
    c, db = client

    def fake_turn(**opts):
        opts["io"].emit({"type": "text_delta", "text": "partial"})
        opts["io"].emit({"type": "memory_saved", "memoryId": "mem_9", "body": "keep this"})
        raise RuntimeError("proxy died")

    monkeypatch.setattr(bp_route, "copilot_turn", fake_turn)

    _, data = _post_stream(c, "/api/v1/blueprints/bp_1/copilot", {"message": "hi", "draft": DRAFT})

    events = _events(data)
    assert events[-1] == {"type": "error", "message": "proxy died"}

    row = db.execute(
        "SELECT body, actions, status FROM copilot_messages WHERE role='assistant'"
    ).fetchone()
    assert row["body"] == "partial"
    assert row["status"] == "failed"
    # Accumulated actions (the memory) persisted on the failed row.
    assert json.loads(row["actions"]) == [{"kind": "memory", "memoryId": "mem_9", "body": "keep this"}]


# --- (6) memories query scope: this blueprint + its project, active, rowid ---


def test_memories_scope_and_order(client, monkeypatch):
    c, db = client
    db.execute("INSERT INTO projects (id, name) VALUES ('proj_2', 'Other')")
    # in-scope: blueprint-scoped active, project-scoped active (proj_1)
    db.execute(
        "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source) "
        "VALUES ('m_bp', 'blueprint', 'proj_1', 'bp_1', 'bp mem', 'copilot')"
    )
    db.execute(
        "INSERT INTO memories (id, scope, project_id, body, source) "
        "VALUES ('m_proj', 'project', 'proj_1', 'proj mem', 'copilot')"
    )
    # out-of-scope: disabled, and a project mem for a different project
    db.execute(
        "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, status) "
        "VALUES ('m_off', 'blueprint', 'proj_1', 'bp_1', 'disabled', 'copilot', 'disabled')"
    )
    db.execute(
        "INSERT INTO memories (id, scope, project_id, body, source) "
        "VALUES ('m_other', 'project', 'proj_2', 'other proj', 'copilot')"
    )

    seen: dict = {}
    monkeypatch.setattr(
        bp_route, "copilot_turn",
        lambda **o: (seen.update(o), {"reply": "ok", "actions": [], "draft": DRAFT})[1],
    )

    _post_stream(c, "/api/v1/blueprints/bp_1/copilot", {"message": "hi", "draft": DRAFT})

    assert seen["memories"] == [
        {"id": "m_bp", "body": "bp mem", "scope": "blueprint"},
        {"id": "m_proj", "body": "proj mem", "scope": "project"},
    ]
