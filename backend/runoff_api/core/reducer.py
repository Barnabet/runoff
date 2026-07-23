"""Port of packages/core/src/reducer.ts — deterministic projection of a run's event log.

Same events + section_meta in always yield the same projection out — no clocks,
no randomness. Runtime shape is plain dicts with camelCase keys; the optional
``document`` / ``stats`` / ``error`` projection keys are present only once set.
"""

from .types.document import blocks_to_plain_text


def reduce_run(events: list[dict], section_meta: list[dict]) -> dict:
    p: dict = {
        "status": "idle",
        "phase": "",
        "sections": {},
        "log": [],
        "questions": {},
        "flags": [],
        "memoryIds": [],
    }

    def number_of(key: str):
        return next((m["number"] for m in section_meta if m["key"] == key), None)

    def drafting_phase(key: str) -> str:
        n = number_of(key)
        return f"DRAFTING §{(n if n is not None else 0):02d}"

    # Ensure a section slot exists before mutating it (run_started normally
    # creates them all, but stay robust if an event references a fresh key).
    def section(key: str) -> dict:
        s = p["sections"].get(key)
        if s is None:
            s = {"state": "queued", "typedText": "", "blocks": [], "retries": 0, "words": 0}
            p["sections"][key] = s
        return s

    # Phase in effect before a pause, restored on resume.
    phase_before_pause = ""

    for e in events:
        t = e["type"]
        if t == "run_started":
            p["status"] = "running"
            p["phase"] = "READING SOURCES"
            mem = e.get("memoryIds")
            p["memoryIds"] = mem if mem is not None else []
            for key in e["sectionKeys"]:
                p["sections"][key] = {
                    "state": "queued", "typedText": "", "blocks": [], "retries": 0, "words": 0,
                }
        elif t == "source_read":
            p["log"].append({"level": "info", "message": f"Read {e['label']} — {e['summary']}"})
        elif t == "section_started":
            section(e["sectionKey"])["state"] = "writing"
            p["phase"] = drafting_phase(e["sectionKey"])
        elif t == "text_delta":
            section(e["sectionKey"])["typedText"] += e["text"]
        elif t == "section_completed":
            s = section(e["sectionKey"])
            s["state"] = "done"
            s["blocks"] = e["blocks"]
            s["words"] = e["words"]
            s["retries"] = e["retries"]
            # Reset typed text to the final rendered wording so replays match output.
            s["typedText"] = blocks_to_plain_text(e["blocks"])
        elif t == "section_failed":
            # A section that could not be drafted (e.g. the model refused). The run
            # continues without it, so the phase is left unchanged.
            section(e["sectionKey"])["state"] = "failed"
            section(e["sectionKey"])["error"] = e["error"]
            p["log"].append({"level": "error", "message": f"§ {e['sectionKey']} failed — {e['error']}"})
        elif t == "check_failed":
            p["log"].append({
                "level": "warn",
                "message": f"Check failed on {e['sectionKey']} — {e['rule']}: {e['detail']}",
            })
        elif t == "retry_started":
            p["log"].append({"level": "info", "message": f"Retrying {e['sectionKey']} — {e['reason']}"})
        elif t == "steer_received":
            p["log"].append({"level": "user", "message": e["text"]})
        elif t == "log":
            p["log"].append({"level": e["level"], "message": e["message"]})
        elif t == "question_raised":
            p["questions"][e["questionId"]] = {
                "sectionKey": e["sectionKey"],
                "question": e["question"],
                "options": e["options"],
                "fallback": e["fallback"],
                "deadlineSection": e["deadlineSection"],
                "status": "open",
            }
        elif t == "question_answered":
            q = p["questions"].get(e["questionId"])
            if q:
                q["status"] = "answered"
                q["answer"] = e["answer"]
        elif t == "question_fallback_applied":
            q = p["questions"].get(e["questionId"])
            if q:
                q["status"] = "fallback"
        elif t == "flag_raised":
            p["flags"].append({
                "flagId": e["flagId"],
                "code": e["code"],
                "sectionKey": e["sectionKey"],
                "question": e["question"],
                "options": e["options"],
            })
        elif t == "paused":
            p["status"] = "paused"
            phase_before_pause = p["phase"]
            p["phase"] = "PAUSED"
        elif t == "resumed":
            p["status"] = "running"
            p["phase"] = phase_before_pause
        elif t == "render_started":
            p["phase"] = "RENDERING"
        elif t == "run_completed":
            p["status"] = "complete"
            p["phase"] = "COMPLETE"
            p["stats"] = e["stats"]
            p["document"] = e["document"]
        elif t == "run_failed":
            p["status"] = "failed"
            p["phase"] = "FAILED"
            p["error"] = e["error"]
            p["log"].append({"level": "error", "message": e["error"]})
        # check_passed is intentionally not projected (no log/state change).

    return p
