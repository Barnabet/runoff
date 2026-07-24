"""Live smoke for the builder copilot — Python twin of scripts/evalCopilot.ts.

One real conversation turn against the local CLIProxyAPI: ask for a
section-instruction tightening on the seeded "Quarterly Performance Report"
blueprint and assert the turn produced at least one applied edit op and a
coherent reply. Unlike the TS twin (which stubs the golden callbacks), this runs
the turn against the REAL Python services — caches + context are built through
resolve_golden / render_golden_for_prompt / scaffold_digest_for /
build_copilot_context, exactly as the copilot route does — over the
already-seeded dev DB (run `pnpm seed` first if the blueprint is absent).

Exit codes match evalCopilot.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
Plain script, no pytest.
"""

import os
import sys
from pathlib import Path

# Running as a script file puts only backend/evals/ on sys.path; add backend/ so
# the runoff_api package (backend/runoff_api) imports without an install step.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import openai  # noqa: E402

from runoff_api.core.db import open_db  # noqa: E402
from runoff_api.core.types.blueprint import BlueprintContent  # noqa: E402
from runoff_api.engine.copilot import copilot_turn  # noqa: E402
from runoff_api.engine.llm import make_llm_client  # noqa: E402
from runoff_api.engine.prompts import MODEL  # noqa: E402
from runoff_api.services.golden_binding import boundness_line, render_golden_for_prompt  # noqa: E402
from runoff_api.services.goldens import list_goldens, resolve_golden, scaffold_digest_for  # noqa: E402
from runoff_api.services.queries import build_copilot_context  # noqa: E402

BLUEPRINT_NAME = "Quarterly Performance Report"


def db_path() -> str:
    return os.environ.get("RUNOFF_DB", "data/runoff.db")


def base_url() -> str:
    return os.environ.get("OPENAI_BASE_URL", "http://localhost:8317/v1")


def preflight(client: openai.OpenAI) -> None:
    """Probe the proxy before spending a full run. Mirrors evalCopilot.ts:
    prints a SKIPPED line and exits 2 (unreachable) / 3 (auth) on failure."""
    try:
        client.models.list()
    except Exception as err:  # noqa: BLE001
        if isinstance(err, openai.APIConnectionError) or getattr(err, "code", None) == "ECONNREFUSED":
            print(f"EVAL SKIPPED — CLIProxyAPI unreachable at {base_url()}", file=sys.stderr)
            sys.exit(2)
        status = getattr(err, "status_code", None) or getattr(err, "status", None)
        if isinstance(err, openai.AuthenticationError) or status in (401, 403):
            print(
                "EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm backend:eval:copilot)",  # noqa: E501
                file=sys.stderr,
            )
            sys.exit(3)
        # Any other failure (e.g. proxy up but /models unimplemented): re-probe with
        # a tiny chat completion, which exercises the exact path the run uses.
        try:
            client.chat.completions.create(
                model=MODEL, max_completion_tokens=1, messages=[{"role": "user", "content": "ping"}]
            )
        except Exception as err2:  # noqa: BLE001
            if isinstance(err2, openai.APIConnectionError) or getattr(err2, "code", None) == "ECONNREFUSED":
                print(f"EVAL SKIPPED — CLIProxyAPI unreachable at {base_url()}", file=sys.stderr)
                sys.exit(2)
            s2 = getattr(err2, "status_code", None) or getattr(err2, "status", None)
            if isinstance(err2, openai.AuthenticationError) or s2 in (401, 403):
                print(
                    "EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm backend:eval:copilot)",  # noqa: E501
                    file=sys.stderr,
                )
                sys.exit(3)
            print(f"EVAL SKIPPED — proxy probe failed: {err2}", file=sys.stderr)
            sys.exit(2)


def load_blueprint(db) -> tuple[str, dict]:
    """Load the seeded blueprint's current-revision content (mirrors loadBlueprint)."""
    row = db.execute(
        "SELECT id, current_rev AS rev FROM blueprints WHERE name = ?", (BLUEPRINT_NAME,)
    ).fetchone()
    if row is None:
        print(f'COPILOT EVAL FAILED — no "{BLUEPRINT_NAME}" blueprint (run pnpm seed first)', file=sys.stderr)
        sys.exit(1)
    rev_row = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?",
        (row["id"], row["rev"]),
    ).fetchone()
    if rev_row is None:
        raise RuntimeError(f"blueprint revision not found: {row['id']}@{row['rev']}")
    import json

    content = BlueprintContent.model_validate(json.loads(rev_row["content"]))
    return row["id"], content.model_dump(by_alias=True, exclude_unset=True)


def build_context(db, blueprint_id: str) -> dict:
    """Build caches + context through the real services, exactly as the copilot route does."""
    golden_cache: dict[str, dict] = {}
    scaffold_cache: dict[str, str] = {}
    for g in list_goldens(db, blueprint_id):
        resolved = resolve_golden(db, g["id"])
        if resolved is None:
            continue
        golden_cache[g["id"]] = {
            "description": f"{resolved['label']} — {boundness_line(resolved['inventory'])}",
            "text": render_golden_for_prompt(resolved),
        }
        scaffold_cache[g["id"]] = scaffold_digest_for(resolved)
    return build_copilot_context(db, blueprint_id, golden_cache, scaffold_cache)


def main() -> None:
    client = make_llm_client()
    preflight(client)
    db = open_db(db_path())
    try:
        blueprint_id, content = load_blueprint(db)
        ctx = build_context(db, blueprint_id)
        edit_ops = 0

        class Io:
            def emit(self, e: dict) -> None:
                nonlocal edit_ops
                if e["type"] == "tool_activity":
                    print(f"[tool] {e['label']}")
                elif e["type"] == "edit":
                    edit_ops += 1
                    print(f"[edit] {e['op']['type']}")
                elif e["type"] == "text_delta":
                    sys.stdout.write(".")
                    sys.stdout.flush()

        res = copilot_turn(
            client=client,
            draft=content,
            selected_key=(content["sections"][0]["key"] if content.get("sections") else None),
            message=(
                "Tighten the first auto section's instruction: demand exactly three sentences "
                "and require the headline spend figure to be cited. Apply the edit."
            ),
            thread=[],
            memories=[],
            ctx=ctx,
            io=Io(),
        )
        sys.stdout.write("\n")
        failures: list[str] = []
        if edit_ops < 1:
            failures.append("no edit op was applied")
        if len(res["reply"].strip()) < 10:
            failures.append(f'reply too short: "{res["reply"]}"')
        if failures:
            print(f"\nCOPILOT EVAL FAILED — {'; '.join(failures)}", file=sys.stderr)
            sys.exit(1)
        print(
            f"\nCOPILOT EVAL OK — {edit_ops} edit op(s), {len(res['actions'])} action(s), "
            f"reply {len(res['reply'])} chars"
        )
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        print(f"\nCOPILOT EVAL FAILED — {err}", file=sys.stderr)
        sys.exit(1)
