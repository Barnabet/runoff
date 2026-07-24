"""Live smoke for propose_parse_plan — Python twin of scripts/evalParse.ts.

Give the model the messy AR-aging fixture (glued title + Grand Total + currency
strings + wide months sheet) and assert the plan it writes actually parses the
file correctly. Name-agnostic: assertions check row counts and sums, not the
model's choice of names. Plain script, exit 1 on failure, no pytest.
"""

import sys
from pathlib import Path

# Running as a script file puts only backend/evals/ on sys.path; add backend/ so
# the runoff_api package (backend/runoff_api) imports without an install step.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runoff_api.engine.llm import make_llm_client  # noqa: E402
from runoff_api.engine.parse_plan import execute_parse_plan, load_grids  # noqa: E402
from runoff_api.engine.propose_plan import build_grid_sample, is_degenerate, propose_parse_plan  # noqa: E402
from runoff_api.engine.tabular import scan_sample, scan_tabular  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[2] / "scripts" / "fixtures"
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def fail(detail: str) -> None:
    print(f"EVAL PARSE FAIL: {detail}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    client = make_llm_client()
    path = str(FIXTURES / "ar_aging_q2_2026.xlsx")
    name = "ar_aging_q2_2026.xlsx"
    grids = load_grids(path, MIME, name)
    scan = scan_tabular(path, MIME, name)
    plan = propose_parse_plan(
        client=client, filename=name, grid_sample=build_grid_sample(grids, scan_sample(scan))
    )
    if not plan:
        fail("no plan proposed")
    result = execute_parse_plan(grids, plan, "2026-Q2", "quarter")
    tables, report = result["tables"], result["report"]
    if is_degenerate(report):
        retry = propose_parse_plan(
            client=client,
            filename=name,
            grid_sample=build_grid_sample(grids, scan_sample(scan)),
            exec_report=report,
        )
        if retry:
            plan = retry
            result = execute_parse_plan(grids, plan, "2026-Q2", "quarter")
            tables, report = result["tables"], result["report"]

    problems = [p for t in report["tables"] for p in t["problems"]]
    if problems:
        fail("plan has problems: " + "; ".join(problems))
    if len(plan["tables"]) < 2:
        fail(f"expected 2 tables, plan has {len(plan['tables'])}")

    # The aging table: 6 data rows, Grand Total excluded, currency parsed — some
    # numeric column must sum to exactly 61,000 (7 rows or unparsed currency
    # cannot produce it: the total row would double it to 122,000).
    def is_num(v: object) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def hits(t: dict) -> bool:
        if len(t["rows"]) != 6:
            return False
        n_cols = len(t["columns"])
        for ci in range(n_cols):
            s = sum(r[ci] for r in t["rows"] if ci < len(r) and is_num(r[ci]))
            if abs(s - 61000) < 0.01:
                return True
        return False

    if not any(hits(t) for t in tables):
        kept = ", ".join(str(len(t["rows"])) for t in tables)
        fail(f"no table kept exactly 6 rows summing to 61000 (kept: {kept})")
    print(f"EVAL PARSE OK: {len(plan['tables'])} tables · aging kept 6 · sum 61,000 verified")


if __name__ == "__main__":
    main()
