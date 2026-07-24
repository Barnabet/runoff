"""Live smoke for the golden unify + bind pipeline — Python twin of
scripts/evalGolden.ts.

Take the seeded AR-review exemplar (baked from the warehouse), unify its stored
markdown LIVE, bind the LIVE-unified document against the seeded warehouse,
verify, and assert the AR total was found and bound to the warehouse's own SUM.
Name-agnostic: it does not pin the model's item ids or SQL, only that some bound
numeric value equals the warehouse total within tolerance and overall boundness
clears 50%. Runs against the already-seeded dev DB (run `pnpm seed` first).

Exit codes match evalGolden.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
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
from runoff_api.core.warehouse import format_sql_result, run_warehouse_sql  # noqa: E402
from runoff_api.core.warehouse_catalog import build_warehouse_catalog  # noqa: E402
from runoff_api.engine.bind_golden import bind_golden  # noqa: E402
from runoff_api.engine.llm import make_llm_client  # noqa: E402
from runoff_api.engine.prompts import MODEL  # noqa: E402
from runoff_api.engine.unify_golden import unify_golden_report  # noqa: E402
from runoff_api.services.golden_binding import verify_inventory  # noqa: E402

PERIOD = "2026-Q1"


def db_path() -> str:
    return os.environ.get("RUNOFF_DB", "data/runoff.db")


def files_dir() -> str:
    return os.environ.get("RUNOFF_FILES_DIR", "data/files")


def base_url() -> str:
    return os.environ.get("OPENAI_BASE_URL", "http://localhost:8317/v1")


def fail(detail: str) -> None:
    print(f"EVAL GOLDEN FAIL: {detail}", file=sys.stderr)
    sys.exit(1)


def preflight(client: openai.OpenAI) -> None:
    """Probe the proxy before spending a full run. Mirrors evalGolden.ts:
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
                "EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm backend:eval:golden)",  # noqa: E501
                file=sys.stderr,
            )
            sys.exit(3)
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
                    "EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm backend:eval:golden)",  # noqa: E501
                    file=sys.stderr,
                )
                sys.exit(3)
            print(f"EVAL SKIPPED — proxy probe failed: {err2}", file=sys.stderr)
            sys.exit(2)


def main() -> None:
    client = make_llm_client()
    preflight(client)
    db = open_db(db_path())
    try:
        # 1. Find the seeded exemplar golden and read its stored markdown.
        g = db.execute(
            "SELECT id, blueprint_id AS blueprintId, name, stored_filename AS storedFilename "
            "FROM goldens WHERE kind='exemplar' AND name LIKE 'AR Review%' ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        if g is None:
            fail("no seeded exemplar golden found (run pnpm seed first)")
        project_id = db.execute(
            "SELECT project_id AS projectId FROM blueprints WHERE id = ?", (g["blueprintId"],)
        ).fetchone()["projectId"]
        text = Path(files_dir(), g["storedFilename"]).read_text(encoding="utf-8")

        # 2. UNIFY LIVE.
        unified = unify_golden_report(client=client, filename=g["storedFilename"], text=text)
        if not unified:
            fail("unify returned null")
        doc = unified["document"]
        if len(doc["sections"]) < 2:
            fail(f"expected >= 2 sections, got {len(doc['sections'])}")
        if unified["period"] != PERIOD:
            fail(f"expected period {PERIOD}, got {unified['period']}")

        # 3. BIND LIVE against the seeded warehouse (cold start: no siblings).
        catalog = build_warehouse_catalog(db, project_id)

        def run_sql(sql: str) -> str:
            return format_sql_result(run_warehouse_sql(project_id, sql, PERIOD))

        def exec_sql(sql: str) -> dict:
            return run_warehouse_sql(project_id, sql, PERIOD)

        submitted = bind_golden(
            client=client, catalog=catalog, run_sql=run_sql, document=doc, period=PERIOD, siblings=[]
        )
        if submitted is None:
            # Self-check mirror: one retry before failing.
            submitted = bind_golden(
                client=client, catalog=catalog, run_sql=run_sql, document=doc, period=PERIOD, siblings=[]
            )
        if submitted is None:
            fail("bind returned null inventory (after one retry)")

        # 4. VERIFY.
        verified = verify_inventory(submitted, exec_sql, PERIOD, doc)

        # 5. Assertions (name-agnostic).
        expected = run_warehouse_sql(
            project_id, "SELECT SUM(amount) FROM fam_ar_transactions WHERE _period = :period", PERIOD
        )["rows"][0][0]
        tol = max(0.005, 0.01 * abs(expected))

        def is_num(v: object) -> bool:
            return isinstance(v, (int, float)) and not isinstance(v, bool)

        total_hit = any(
            i.get("binding")
            and i["binding"]["status"] == "bound"
            and is_num(i["binding"]["verifiedValue"])
            and abs(i["binding"]["verifiedValue"] - expected) <= tol
            for i in verified["items"]
        )
        if not total_hit:
            bounds = [
                str(i["binding"]["verifiedValue"])
                for i in verified["items"]
                if i.get("binding") and i["binding"]["status"] == "bound"
            ]
            fail(
                f"no bound numeric item within tolerance of AR total {expected} "
                f"(bound values: {', '.join(bounds) or 'none'})"
            )
        total = len(verified["items"])
        bound = sum(1 for i in verified["items"] if i.get("binding") and i["binding"]["status"] == "bound")
        if total == 0 or bound / total < 0.5:
            fail(f"boundness {bound}/{total} below 0.5")

        print("EVAL GOLDEN OK")
        print(
            f"  unified {len(doc['sections'])} sections · bound {bound}/{total} items · "
            f"AR total {expected} verified within ±{tol:.2f}"
        )
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        print(f"\nEVAL GOLDEN FAIL — {err}", file=sys.stderr)
        sys.exit(1)
