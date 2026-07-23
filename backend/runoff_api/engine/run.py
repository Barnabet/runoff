"""Port of packages/engine/src/run.ts — the run orchestrator.

Heart of the run engine. Streams a blueprint through the model section by section
— draining live inputs, applying question fallbacks, running checks with a single
retry, raising flags — then assembles the document and stats. Emits ``run_failed``
and re-raises on any unrecoverable error (rule 9). TS wins on every statement.

Runtime shapes are plain camelCase-keyed dicts; execution is synchronous. ``io``
is duck-typed with:
  - ``emit(event: dict)`` — publish a RunEvent
  - ``poll_inputs() -> list[dict]`` — drain pending RunInputMsg dicts
    ({"kind": "pause"|"resume"|"steer"|"answer", "text"?, "questionId"?})
  - ``sleep(ms: float)`` — injected so tests can no-op the pause loop

Timing: TS ``Date.now()`` deltas become ``int(time.time() * 1000)`` ms integers.
"""

import time
from types import SimpleNamespace

from runoff_api.core.dialect import parse_section_text
from runoff_api.core.types.document import blocks_to_plain_text, count_words
from runoff_api.engine.checks import audit_citations, count_citations, evaluate_assert
from runoff_api.engine.draft import RefusalError, draft_section
from runoff_api.engine.run_data import section_data_block
from runoff_api.engine.source_pack import build_source_pack


def _now_ms() -> int:
    return int(time.time() * 1000)


def execute_run(
    *,
    client,
    content: dict,
    files: list[dict],
    data: dict,
    io,
    blueprint_rev: int,
    previous_document: dict | None = None,
    memories: list[dict] | None = None,
    period: str | None = None,
    gaps: list[str] | None = None,
) -> dict:
    memories = memories if memories is not None else []
    # Project-scope memories are listed first (they set standing context), then
    # blueprint-scope; this order is what run_started.memoryIds records.
    ordered_memories = [m for m in memories if m["scope"] == "project"] + [
        m for m in memories if m["scope"] == "blueprint"
    ]
    emit = io.emit
    run_start = _now_ms()

    # Run-wide mutable state.
    steers: list[str] = []
    answers: list[dict] = []
    completed: list[dict] = []
    open_questions: dict[str, dict] = {}
    model_flagged_sections: set[str] = set()

    counters = {
        "questionCounter": 0,
        "flagCounter": 0,
        "checksPassed": 0,
        "checksFailed": 0,
        "flagCount": 0,
        "totalRetries": 0,
    }

    def raise_flag(section_key: str, question: str, options: list[str]) -> None:
        counters["flagCounter"] += 1
        emit({
            "type": "flag_raised",
            "flagId": f"flag_{counters['flagCounter']}",
            "code": f"F{counters['flagCounter']}",
            "sectionKey": section_key,
            "question": question,
            "options": options,
        })
        counters["flagCount"] += 1

    # --- live inputs (rule 3) ------------------------------------------------
    def handle_steer(text: str) -> None:
        steers.append(text)
        emit({"type": "steer_received", "text": text})

    def handle_answer(msg: dict) -> None:
        question_id = msg.get("questionId") or ""
        answer = msg.get("text") or ""
        q = open_questions.get(question_id)
        if q:
            q["status"] = "answered"
            answers.append({"question": q["question"], "answer": answer})
        else:
            answers.append({"question": question_id, "answer": answer})
        emit({"type": "question_answered", "questionId": question_id, "answer": answer})

    def wait_for_resume() -> None:
        while True:
            io.sleep(200)
            resumed = False
            for msg in io.poll_inputs():
                if msg["kind"] == "resume":
                    resumed = True
                elif msg["kind"] == "steer":
                    handle_steer(msg.get("text") or "")
                elif msg["kind"] == "answer":
                    handle_answer(msg)
                # a nested pause while already paused is a no-op
            if resumed:
                emit({"type": "resumed"})
                return

    def drain_inputs() -> None:
        for msg in io.poll_inputs():
            if msg["kind"] == "steer":
                handle_steer(msg.get("text") or "")
            elif msg["kind"] == "answer":
                handle_answer(msg)
            elif msg["kind"] == "pause":
                emit({"type": "paused"})
                wait_for_resume()
            # a stray resume with no active pause is a no-op

    # --- question fallbacks (rule 4) -----------------------------------------
    def apply_fallbacks(current_key: str) -> None:
        for question_id, q in open_questions.items():
            if q["status"] == "open" and q["deadlineSection"] == current_key:
                q["status"] = "fallback"
                steers.append(f"Assume: {q['fallback']}")
                emit({"type": "question_fallback_applied", "questionId": question_id})

    # --- draft callbacks (rule 5) --------------------------------------------
    def make_callbacks(section_key: str):
        def on_delta(text):
            emit({"type": "text_delta", "sectionKey": section_key, "text": text})

        def on_question(q):
            counters["questionCounter"] += 1
            question_id = f"q{counters['questionCounter']}"
            open_questions[question_id] = {
                "question": q["question"],
                "options": q["options"],
                "fallback": q["fallback"],
                "deadlineSection": q["deadlineSection"],
                "status": "open",
            }
            emit({
                "type": "question_raised",
                "questionId": question_id,
                "sectionKey": section_key,
                "question": q["question"],
                "options": q["options"],
                "fallback": q["fallback"],
                "deadlineSection": q["deadlineSection"],
            })

        def on_flag(f):
            model_flagged_sections.add(section_key)
            raise_flag(section_key, f["question"], f["options"])

        return SimpleNamespace(on_delta=on_delta, on_question=on_question, on_flag=on_flag)

    # --- checks (rule 6) -----------------------------------------------------
    # Returns the failure details (empty ⇒ clean). Emits check_passed/check_failed.
    def run_checks(section: dict, blocks: list[dict]) -> list[str]:
        details: list[str] = []

        for rule in section["rules"]:
            if rule["kind"] != "assert":
                continue
            # v1 semantics: an assert without `sql` is prompt-only guidance (its text
            # is already woven into the drafting prompt). Skip it at run time so it
            # can't hard-fail via evaluate_assert's defensive "missing sql/op/value"
            # contract.
            if rule.get("sql") is None:
                continue
            rule_name = rule["text"] if rule["text"].strip() else (rule.get("sql") or "assert")
            res = evaluate_assert(rule, data)
            if res["pass"]:
                emit({"type": "check_passed", "sectionKey": section["key"], "rule": rule_name})
                counters["checksPassed"] += 1
            else:
                emit({
                    "type": "check_failed",
                    "sectionKey": section["key"],
                    "rule": rule_name,
                    "detail": res["detail"],
                })
                counters["checksFailed"] += 1
                details.append(res["detail"])

        audit = audit_citations(blocks, data, section["familyIds"])
        if audit["pass"]:
            emit({"type": "check_passed", "sectionKey": section["key"], "rule": "citations"})
            counters["checksPassed"] += 1
        else:
            emit({
                "type": "check_failed",
                "sectionKey": section["key"],
                "rule": "citations",
                "detail": "; ".join(audit["failures"]),
            })
            counters["checksFailed"] += 1
            details.extend(audit["failures"])

        return details

    try:
        # Rule 1: announce the run, build the source pack, surface each source.
        run_started = {
            "type": "run_started",
            "sectionKeys": [s["key"] for s in content["sections"]],
            "blueprintRev": blueprint_rev,
        }
        if ordered_memories:
            run_started["memoryIds"] = [m["id"] for m in ordered_memories]
        if period:
            run_started["period"] = period
        if gaps:
            run_started["gaps"] = gaps
        emit(run_started)
        pack = build_source_pack(files)
        for src in pack["sources"]:
            emit({
                "type": "source_read",
                "sourceId": src["id"],
                "label": src["label"],
                "summary": src["summary"],
            })

        # Rule 2: process sections in `number` order.
        ordered = sorted(content["sections"], key=lambda s: s["number"])
        for section in ordered:
            section_start = _now_ms()

            # Rule 3: drain live inputs (steer / answer / pause-resume).
            drain_inputs()
            # Rule 4 (before draft): questions whose deadline is this section fall back.
            apply_fallbacks(section["key"])

            # Rule 2: fixed sections take no model call.
            if section["mode"] == "fixed":
                emit({"type": "section_started", "sectionKey": section["key"]})
                blocks = parse_section_text(section.get("fixedText") or "")
                completed.append({"key": section["key"], "heading": section["heading"], "blocks": blocks})
                emit({
                    "type": "section_completed",
                    "sectionKey": section["key"],
                    "blocks": blocks,
                    "words": count_words(blocks),
                    "ms": _now_ms() - section_start,
                    "retries": 0,
                })
                continue

            # Rule 5: draft the section, wiring streaming/question/flag callbacks.
            # A refusal is contained to this section (emit `section_failed`, skip it,
            # keep going); any other draft error propagates and fails the whole run.
            emit({"type": "section_started", "sectionKey": section["key"]})
            cb = make_callbacks(section["key"])
            prev_section = (
                next((s for s in previous_document["sections"] if s["key"] == section["key"]), None)
                if previous_document
                else None
            )
            previous_section_text = blocks_to_plain_text(prev_section["blocks"]) if prev_section else None
            data_block = section_data_block(section, data, pack)
            try:
                draft = draft_section(
                    client=client,
                    content=content,
                    section=section,
                    data_block=data_block,
                    completed=completed,
                    steers=steers,
                    answers=answers,
                    previous_section_text=previous_section_text,
                    memories=memories,
                    cb=cb,
                )
                blocks = draft["blocks"]
                # Rule 4 (same section): a question raised during this draft, deadlined here, falls back now.
                apply_fallbacks(section["key"])

                # Rule 6: checks, with at most one retry, then flag-and-keep.
                retries = 0
                failures = run_checks(section, blocks)
                if len(failures) > 0:
                    emit({
                        "type": "retry_started",
                        "sectionKey": section["key"],
                        "reason": "; ".join(failures),
                    })
                    retries = 1
                    counters["totalRetries"] += 1
                    # An answer or steer posted while the first draft was being written
                    # or checked must reach the redraft (v1.1 spec §4b).
                    drain_inputs()
                    draft = draft_section(
                        client=client,
                        content=content,
                        section=section,
                        data_block=data_block,
                        completed=completed,
                        steers=steers,
                        answers=answers,
                        retry_feedback="; ".join(failures),
                        previous_section_text=previous_section_text,
                        memories=memories,
                        cb=cb,
                    )
                    blocks = draft["blocks"]
                    apply_fallbacks(section["key"])
                    failures = run_checks(section, blocks)
                    if len(failures) > 0:
                        raise_flag(
                            section["key"],
                            f"Section '{section['heading']}' failed checks: "
                            f"{'; '.join(failures)}. Keep it anyway?",
                            ["Keep", "Redraft next run"],
                        )

                # Rule 7: review sections get a flag unless the model already raised one.
                if section["mode"] == "review" and section["key"] not in model_flagged_sections:
                    raise_flag(
                        section["key"],
                        f"Review '{section['heading']}' before release.",
                        ["Approve", "Needs work"],
                    )

                completed.append({"key": section["key"], "heading": section["heading"], "blocks": blocks})
                emit({
                    "type": "section_completed",
                    "sectionKey": section["key"],
                    "blocks": blocks,
                    "words": count_words(blocks),
                    "ms": _now_ms() - section_start,
                    "retries": retries,
                })
            except RefusalError as err:
                emit({"type": "section_failed", "sectionKey": section["key"], "error": str(err)})
                continue

        # Rule 8: render, assemble the document, tally stats, complete.
        emit({"type": "render_started"})
        document = {
            "title": content["title"],
            "eyebrow": content["eyebrow"],
            "dateline": content["dateline"],
            "sections": completed,
        }
        stats = {
            "durationMs": _now_ms() - run_start,
            "words": sum(count_words(s["blocks"]) for s in completed),
            "sourcesUsed": len(pack["sources"]),
            "checksPassed": counters["checksPassed"],
            "checksFailed": counters["checksFailed"],
            "flagCount": counters["flagCount"],
            "citationCount": sum(count_citations(s["blocks"]) for s in completed),
            "retries": counters["totalRetries"],
        }
        emit({"type": "run_completed", "stats": stats, "document": document})
        return {"document": document, "stats": stats}
    except Exception as err:
        # Rule 9: surface the failure, then propagate.
        emit({"type": "run_failed", "error": str(err)})
        raise
