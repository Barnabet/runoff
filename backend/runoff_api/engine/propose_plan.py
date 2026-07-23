"""Port of packages/engine/src/proposePlan.ts — render a grid sample, make one
structured (or amending) ParsePlan proposal call, and the degeneracy self-check.

``propose_parse_plan`` does one structured call proposing (or amending) a
ParsePlan; Zod (pydantic) + structural validation; one retry on invalid; None on
any failure — callers fall back to the plan-less flow. The amend/feedback variant
lives entirely in the optional ``existing_plan`` / ``fit_detail`` / ``exec_report``
/ ``feedback`` params, mirroring the TS opts.

Runtime shapes are plain dicts with camelCase keys (grids ``{"sheet","grid"}``,
ExecReport, ParsePlan). The request payload (model, messages, response_format,
max_completion_tokens) is field-for-field identical to the TS ``create(...)``
object literal — a later task byte-checks it.
"""

import json

from runoff_api.core.types.parse_plan import ParsePlan, validate_parse_plan
from runoff_api.engine.parse_plan import raw_cell
from runoff_api.engine.prompts import MODEL

SAMPLE_ROWS = 30
SAMPLE_COLS = 15
SAMPLE_CAP = 6000
CELL_CAP = 20


def build_grid_sample(grids: list[dict], hints: str) -> str:
    parts: list[str] = []
    for g in grids:
        sheet = g["sheet"]
        grid = g["grid"]
        rows = max(len(grid), 0)
        cols = 0
        for r in grid:
            cols = max(cols, len(r if r is not None else []))
        lines = [f"## sheet: {sheet} ({rows}×{cols})"]
        for r in range(min(rows, SAMPLE_ROWS)):
            row = grid[r] if grid[r] is not None else []
            cells = [raw_cell(v)[:CELL_CAP] for v in row[:SAMPLE_COLS]]
            lines.append(f"R{r + 1}: {' | '.join(cells)}")
        parts.append("\n".join(lines))
    parts.append(f"## detector hints\n{hints}")
    return "\n\n".join(parts)[:SAMPLE_CAP]


PLAN_CONTRACT = (
    'Return JSON matching: {"version":1,"tables":[{"name":snake_case,"anchor":{"sheet"?:slug,'
    '"headerSignature":[normalized header cell texts],"minMatch":int},"headerRows":1-3,'
    '"exclude":[{"column":canonical|null,"pattern":regex}],"columns":[{"from":normalized merged header,'
    '"name":snake_case,"type":"TEXT"|"INTEGER"|"REAL","parse"?:"number"|"currency"|"percent"|"date"}],'
    '"unpivot"?:{"keep":[canonical],"valuePattern":regex,"keyColumn":snake_case,"valueColumn":snake_case,'
    '"valueType":"INTEGER"|"REAL"|"TEXT","valueParse"?:"number"|"currency"|"percent"},'
    '"periodColumn"?:canonical (its column MUST have parse "date"),"onPeriodMismatch"?:"keep"|"exclude"}]}. '
    "Header/from texts are lowercase, whitespace-collapsed. One entry per REAL data table; title rows, "
    "notes and total rows are NOT tables. Exclude total/subtotal rows with an exclude rule on a key column. "
    "Set minMatch ≈ two-thirds of the signature length. Unpivot wide period-like column layouts. "
    'Use parse for formatted values ("$1,234"→currency, "12%"→percent, dates→date). '
    "Patterns are ECMAScript regex — no PCRE inline flags like (?i); matching is already case-insensitive."
)


def propose_parse_plan(
    *,
    client,
    filename: str,
    grid_sample: str,
    existing_plan: dict | None = None,
    fit_detail: list[str] | None = None,
    exec_report: dict | None = None,
    feedback: str | None = None,
) -> dict | None:
    amendment = (
        " You are AMENDING a working plan. You MUST keep every existing logical table name and canonical "
        "column name; "
        're-anchor and re-map "from" texts onto them. You may ADD new columns; never remove or rename '
        "existing ones."
        if existing_plan
        else ""
    )
    system = (
        "You write parse plans that turn one uploaded spreadsheet/CSV into clean database tables. "
        "A deterministic engine executes your plan; anchors locate each table's header row by cell-text "
        f"signature, so plans survive moved/renamed sheets. {PLAN_CONTRACT}{amendment}"
    )
    user_parts = [f"Filename: {filename}", f"File sample:\n{grid_sample}"]
    if existing_plan:
        plan_json = json.dumps(existing_plan, separators=(",", ":"), ensure_ascii=False)
        user_parts.append(f"Existing plan:\n{plan_json}")
    if fit_detail:
        user_parts.append("Fit problems:\n" + "\n".join(fit_detail))
    if exec_report:
        report_json = json.dumps(exec_report, separators=(",", ":"), ensure_ascii=False)
        user_parts.append(f"Execution report of the previous attempt:\n{report_json}")
    if feedback:
        user_parts.append(f"User feedback:\n{feedback}")

    for _attempt in range(2):
        try:
            res = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": "\n\n".join(user_parts)},
                ],
                response_format={"type": "json_object"},
                max_completion_tokens=2000,
            )
            choices = getattr(res, "choices", None)
            raw = (choices[0].message.content if choices else None) or ""
        except Exception:  # noqa: BLE001 — mirrors the TS catch-all
            return None
        try:
            plan = ParsePlan.model_validate(json.loads(raw)).model_dump(by_alias=True, exclude_unset=True)
            # zod's ParsePlanSchema applies .default("keep") to onPeriodMismatch (its only
            # default); exclude_unset drops it, so back-fill to keep persisted rows byte-equal
            # to the TS stack (proposals are stored as JSON and echoed in API responses).
            for t in plan["tables"]:
                t.setdefault("onPeriodMismatch", "keep")
            validate_parse_plan(plan)
            return plan
        except Exception:  # noqa: BLE001 — JSON.parse throw, safeParse failure, and validateParsePlan throw all retry
            continue
    return None


def is_degenerate(report: dict) -> bool:
    """Should the self-check round fire? See plan Global Constraints for the pinned criteria."""
    return any(
        len(t["problems"]) > 0
        or t["rowsKept"] == 0
        or any(t["rowsKept"] > 0 and f["count"] >= t["rowsKept"] for f in t["coercionFailures"])
        for t in report["tables"]
    )
