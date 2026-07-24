"""Port of apps/worker/src/index.ts — the worker entrypoint.

Boots recovery, then polls the shared DB for queued runs, executing one per
iteration. A run's own failure is handled inside `process_one`; the outer guard
catches an escaping error (e.g. a claim/DB fault) so the poll loop never dies.
"""

import os
import sys
import time

from runoff_api.core.db import open_db
from runoff_api.engine.llm import make_llm_client
from runoff_api.worker.run_loop import fail_stale_runs, process_one


def main() -> None:
    db = open_db(os.environ.get("RUNOFF_DB", "data/runoff.db"))

    recovered = fail_stale_runs(db)
    if recovered > 0:
        print(f"[worker] recovered {recovered} stale run(s) on boot")

    client = make_llm_client()

    print("[worker] polling for queued runs…")
    while True:
        try:
            if not process_one(db, client):
                time.sleep(0.25)
        except Exception as err:  # noqa: BLE001 — never let the poll loop die
            print("[worker] poll loop error:", err, file=sys.stderr)
            time.sleep(1.0)


if __name__ == "__main__":
    main()
