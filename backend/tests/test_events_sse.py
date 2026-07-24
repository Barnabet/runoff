"""Contract tests for GET /api/v1/runs/{id}/events (docs/api/v1.md §3.1).

Terminal-run behaviours (full replay, raw-payload bytes, run_failed) go through a
real FastAPI TestClient against a temp app DB with run_events rows inserted
directly — those streams complete on their own, so the whole HTTP body is read
back and asserted byte-for-byte.

The two infinite-stream behaviours (idle heartbeat, unknown id) cannot be tested
through TestClient: its blocking-portal transport buffers the entire response and
never yields a chunk until the stream ends, so an unbounded SSE stream would hang
the client forever (verified empirically). Those are driven against the sync
generator `run_event_stream` directly — pulling a bounded number of frames with
`next()` then `gen.close()`, which also exercises the generator's silent
GeneratorExit handling. runs.EVENTS_POLL_SECONDS / EVENTS_HEARTBEAT_EVERY are
monkeypatched to keep the timing deterministic and fast.
"""

import itertools
import json
import threading

import pytest
from fastapi.testclient import TestClient

from runoff_api.api import runs as runs_route
from runoff_api.main import create_app


@pytest.fixture()
def app_db(tmp_path, monkeypatch):
    # Fast, deterministic timing for every test in this module.
    monkeypatch.setattr(runs_route, "EVENTS_POLL_SECONDS", 0.01)
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        db = app.state.db
        db.execute(
            "INSERT INTO blueprints (id, name, current_rev) VALUES ('bp_1','B',1)"
        )
        yield c, db


def _add_event(db, run_id, seq, type_, payload_obj):
    db.execute(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)",
        (run_id, seq, type_, json.dumps(payload_obj)),
    )


def _add_run(db, run_id="run_1"):
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) "
        "VALUES (?, 'bp_1', 1, 'running')",
        (run_id,),
    )


def _join_or_fail(fn, timeout, message):
    """Run `fn` (a blocking stream read) on a daemon reader thread and join it
    with a timeout. A hung read fails the test loudly instead of blocking the
    suite forever — the daemon thread is abandoned and dies with the process,
    which is safe here because closing a generator from another thread while it
    is executing is not (it raises "generator already executing")."""
    box: dict = {}

    def worker():
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 — re-raised on the main thread below
            box["error"] = exc

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        pytest.fail(message)
    if "error" in box:
        raise box["error"]
    return box["result"]


def _read_bytes(client, url, timeout=2.0):
    """Read a self-terminating stream fully; return (headers, raw bytes). A read
    that never terminates fails the test on timeout rather than hanging."""

    def read():
        with client.stream("GET", url) as r:
            return dict(r.headers), b"".join(r.iter_raw())

    return _join_or_fail(
        read, timeout, f"SSE stream {url} did not terminate within {timeout}s"
    )


def _take_frames(db, run_id, want, timeout=2.0):
    """Pull `want` frames from the sync generator, then close it — on a reader
    thread joined with a timeout so a broken (never-yielding) loop fails the test
    instead of hanging the suite."""

    def pull():
        gen = runs_route.run_event_stream(db, run_id)
        try:
            return list(itertools.islice(gen, want))
        finally:
            gen.close()

    return _join_or_fail(
        pull, timeout, f"run_event_stream did not yield {want} frames within {timeout}s"
    )


def _payloads(data: bytes) -> list[dict]:
    frames = [f for f in data.decode().split("\n\n") if f]
    return [json.loads(f[len("data: ") :]) for f in frames]


# --- (a) finished run replays the whole log and ends after run_completed ----


def test_finished_run_replays_full_log_in_seq_order(app_db):
    client, db = app_db
    _add_run(db)
    _add_event(db, "run_1", 1, "run_started", {"type": "run_started", "sectionKeys": ["s"]})
    _add_event(db, "run_1", 2, "section_started", {"type": "section_started", "sectionKey": "s"})
    _add_event(db, "run_1", 3, "section_completed", {"type": "section_completed", "sectionKey": "s"})
    _add_event(db, "run_1", 4, "run_completed", {"type": "run_completed", "stats": {}})

    headers, data = _read_bytes(client, "/api/v1/runs/run_1/events")

    assert headers["content-type"].startswith("text/event-stream")
    assert headers["cache-control"] == "no-cache"
    assert headers["connection"] == "keep-alive"
    types = [p["type"] for p in _payloads(data)]
    assert types == ["run_started", "section_started", "section_completed", "run_completed"]
    # Stream ends immediately after the terminal frame — nothing trails it.
    assert data.rstrip(b"\n").endswith(b"}")


# --- (b) payloads are the raw stored JSON, byte-for-byte ---------------------


def test_frames_are_raw_stored_payload_bytes(app_db):
    client, db = app_db
    _add_run(db)
    # Deliberately awkward content: unicode, embedded colon, spacing — proves the
    # frame carries the stored bytes verbatim, not a re-serialization.
    _add_event(
        db,
        "run_1",
        1,
        "log",
        {"type": "log", "level": "info", "message": "café: 1 < 2  x"},
    )
    _add_event(db, "run_1", 2, "run_completed", {"type": "run_completed", "stats": {"n": 3}})

    _, data = _read_bytes(client, "/api/v1/runs/run_1/events")

    rows = db.execute(
        "SELECT payload FROM run_events WHERE run_id = 'run_1' ORDER BY seq"
    ).fetchall()
    expected = "".join(f"data: {row['payload']}\n\n" for row in rows).encode()
    assert data == expected


# --- (c) idle run emits heartbeat comments -----------------------------------


def test_idle_run_emits_heartbeat(app_db, monkeypatch):
    _, db = app_db
    monkeypatch.setattr(runs_route, "EVENTS_HEARTBEAT_EVERY", 1)
    _add_run(db)
    started = {"type": "run_started", "sectionKeys": []}
    _add_event(db, "run_1", 1, "run_started", started)
    # No terminal event: the loop tails forever, emitting a ping every iteration.

    frames = _take_frames(db, "run_1", want=3)

    # Backlog replays first, then heartbeats keep the (never-terminating) stream alive.
    assert frames[0] == f"data: {json.dumps(started)}\n\n"
    assert ": ping\n\n" in frames[1:]


def test_heartbeat_lands_on_every_nth_idle_iteration_no_off_by_one(app_db, monkeypatch):
    _, db = app_db
    monkeypatch.setattr(runs_route, "EVENTS_HEARTBEAT_EVERY", 2)
    # Count idle poll iterations by recording each loop sleep (made instant).
    sleeps: list = []
    monkeypatch.setattr(runs_route.time, "sleep", lambda s: sleeps.append(s))

    def pull_pairs():
        gen = runs_route.run_event_stream(db, "idle")  # unknown id -> pure idle loop
        out = []
        try:
            for _ in range(2):
                # Snapshot the iteration count at the instant each heartbeat is yielded.
                out.append((next(gen), len(sleeps)))
        finally:
            gen.close()
        return out

    (frame1, n1), (frame2, n2) = _join_or_fail(
        pull_pairs, 2.0, "idle heartbeat loop did not yield within 2s"
    )

    assert frame1 == ": ping\n\n"
    assert frame2 == ": ping\n\n"
    # With EVERY=2 the ping lands on the 2nd iteration: exactly one idle poll
    # precedes the first heartbeat (0 would be an off-by-one low, 2 too late).
    assert n1 == 1
    # ...and every subsequent heartbeat is exactly EVERY iterations later.
    assert n2 - n1 == 2


# --- (d) unknown run id keeps the stream open with heartbeats -----------------


def test_unknown_run_id_stays_open_with_heartbeats(app_db, monkeypatch):
    _, db = app_db
    monkeypatch.setattr(runs_route, "EVENTS_HEARTBEAT_EVERY", 1)

    frames = _take_frames(db, "nope", want=3)

    # No rows to replay — the stream stays open, emitting only heartbeats.
    assert frames == [": ping\n\n", ": ping\n\n", ": ping\n\n"]


# --- (e) run_failed also terminates the stream -------------------------------


def test_run_failed_terminates_stream(app_db):
    client, db = app_db
    _add_run(db)
    _add_event(db, "run_1", 1, "run_started", {"type": "run_started", "sectionKeys": []})
    _add_event(db, "run_1", 2, "run_failed", {"type": "run_failed", "error": "boom"})

    _, data = _read_bytes(client, "/api/v1/runs/run_1/events")

    types = [p["type"] for p in _payloads(data)]
    assert types == ["run_started", "run_failed"]
