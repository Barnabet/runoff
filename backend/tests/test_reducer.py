"""Ports packages/core/test/reducer.test.ts — event lists transcribed as dict literals."""

from runoff_api.core.reducer import reduce_run

META = [{"key": "kpi", "number": 1}, {"key": "exec", "number": 2}]


def test_projects_a_full_run_lifecycle():
    events = [
        {"type": "run_started", "sectionKeys": ["kpi", "exec"], "blueprintRev": 15},
        {"type": "source_read", "sourceId": "src_a", "label": "spend_june.csv", "summary": "42 rows"},
        {"type": "section_started", "sectionKey": "kpi"},
        {"type": "text_delta", "sectionKey": "kpi", "text": "Total spend "},
        {"type": "text_delta", "sectionKey": "kpi", "text": "was flat."},
        {"type": "section_completed", "sectionKey": "kpi",
         "blocks": [{"type": "paragraph", "spans": [{"text": "Total spend was flat."}]}],
         "words": 4, "ms": 1200, "retries": 0},
        {"type": "section_started", "sectionKey": "exec"},
    ]
    p = reduce_run(events, META)
    assert p["status"] == "running"
    assert p["phase"] == "DRAFTING §02"
    assert p["sections"]["kpi"]["state"] == "done"
    assert p["sections"]["kpi"]["typedText"] == "Total spend was flat."
    assert p["sections"]["exec"]["state"] == "writing"


def test_marks_a_section_failed_and_logs_it_without_changing_the_phase():
    events = [
        {"type": "run_started", "sectionKeys": ["kpi", "exec"], "blueprintRev": 1},
        {"type": "section_started", "sectionKey": "kpi"},
        {"type": "section_failed", "sectionKey": "kpi", "error": "model refused to draft this section"},
        {"type": "section_started", "sectionKey": "exec"},
    ]
    p = reduce_run(events, META)
    assert p["sections"]["kpi"]["state"] == "failed"
    assert p["phase"] == "DRAFTING §02"
    assert {"level": "error", "message": "§ kpi failed — model refused to draft this section"} in p["log"]


def test_records_the_section_failed_error_on_the_section_record():
    p = reduce_run(
        [
            {"type": "run_started", "sectionKeys": ["s1"], "blueprintRev": 1},
            {"type": "section_started", "sectionKey": "s1"},
            {"type": "section_failed", "sectionKey": "s1", "error": "model refused to draft this section"},
        ],
        [{"key": "s1", "number": 1}],
    )
    assert p["sections"]["s1"]["state"] == "failed"
    assert p["sections"]["s1"]["error"] == "model refused to draft this section"


def test_stores_run_started_memory_ids_on_the_projection():
    p = reduce_run(
        [{"type": "run_started", "blueprintRev": 1, "sectionKeys": ["a"], "memoryIds": ["mem_1", "mem_2"]}],
        META,
    )
    assert p["memoryIds"] == ["mem_1", "mem_2"]


def test_tracks_pause_questions_and_completion():
    events = [
        {"type": "run_started", "sectionKeys": ["kpi"], "blueprintRev": 1},
        {"type": "question_raised", "questionId": "q1", "sectionKey": "kpi", "question": "Cite them?",
         "options": ["Cite them", "Leave it out"], "fallback": "leave unattributed",
         "deadlineSection": "kpi"},
        {"type": "paused"},
    ]
    p = reduce_run(events, META)
    assert p["phase"] == "PAUSED"
    assert p["questions"]["q1"]["status"] == "open"
    done = reduce_run(
        [
            *events,
            {"type": "resumed"},
            {"type": "question_fallback_applied", "questionId": "q1"},
            {"type": "run_completed",
             "stats": {"durationMs": 14200, "words": 2140, "sourcesUsed": 5, "checksPassed": 10,
                       "checksFailed": 0, "flagCount": 2, "citationCount": 31, "retries": 1},
             "document": {"title": "t", "eyebrow": "e", "dateline": "d", "sections": []}},
        ],
        META,
    )
    assert done["status"] == "complete"
    assert done["questions"]["q1"]["status"] == "fallback"
    assert done["stats"]["words"] == 2140


# Python-specific case required by the task brief.
def test_projection_omits_unset_optional_keys():
    p = reduce_run([], [])
    assert "document" not in p and "stats" not in p and "error" not in p
