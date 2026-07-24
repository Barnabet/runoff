"""Port of apps/web/lib/planPropose.ts — the full plan decision for one upload.

``plan_for_upload`` is the orchestration the classify + replan routes share:
stored-plan fit (zero LLM) -> amendment -> fresh proposal, with the single
automatic self-check round. It composes the engine primitives (load_grids,
build_grid_sample/scan_sample, propose_parse_plan, execute_parse_plan,
fit_parse_plan, is_degenerate) exactly as the TS lib does.

Runtime shapes are plain dicts with camelCase keys. A ``PlanOutcome`` is either
``{"planStatus": "none"}`` or a dict carrying ``plan``/``planStatus``/``preview``/
``report``/``outputSchemas`` (the last is used only for drift enrichment and is
NOT persisted in the proposal JSON).
"""

from runoff_api.engine.parse_plan import execute_parse_plan, fit_parse_plan, load_grids
from runoff_api.engine.propose_plan import build_grid_sample, is_degenerate, propose_parse_plan
from runoff_api.engine.tabular import scan_sample

PREVIEW_ROWS = 8


def build_preview(tables: list[dict]) -> dict:
    """Preview shape for the confirm UI: <=8 rows per table, numbers/null kept,
    everything else stringified (mirrors the TS `typeof v === "number"` guard —
    booleans stringify, since JS `typeof true === "boolean"`)."""
    return {
        "tables": [
            {
                "name": t["logical"],
                "columns": [c["name"] for c in t["columns"]],
                "rows": [
                    [
                        v
                        if v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))
                        else str(v)
                        for v in r
                    ]
                    for r in t["rows"][:PREVIEW_ROWS]
                ],
            }
            for t in tables
        ]
    }


def _schemas_of(tables: list[dict]) -> list[dict]:
    return [{"name": t["logical"], "columns": t["columns"]} for t in tables]


def plan_for_upload(
    *,
    client,
    filename: str,
    path: str,
    mime: str,
    scan: dict,
    stored_plan: dict | None,
    slot_period: str | None,
    granularity: str | None,
    feedback: str | None = None,
) -> dict:
    grids = load_grids(path, mime, filename)

    def exec_plan(plan: dict) -> dict:
        return execute_parse_plan(grids, plan, slot_period, granularity)

    def propose_with_self_check(
        *, existing_plan: dict | None = None, fit_detail: list[str] | None = None,
        feedback: str | None = None,
    ) -> dict | None:
        grid_sample = build_grid_sample(grids, scan_sample(scan))
        plan = propose_parse_plan(
            client=client, filename=filename, grid_sample=grid_sample,
            existing_plan=existing_plan, fit_detail=fit_detail, feedback=feedback,
        )
        if not plan:
            return None
        result = exec_plan(plan)
        tables, report = result["tables"], result["report"]
        if is_degenerate(report):
            retry = propose_parse_plan(
                client=client, filename=filename, grid_sample=grid_sample,
                existing_plan=existing_plan, fit_detail=fit_detail, feedback=feedback,
                exec_report=report,
            )
            if retry:
                plan = retry
                result = exec_plan(plan)
                tables, report = result["tables"], result["report"]
        plan_status = "amended" if existing_plan else "proposed"
        return {
            "plan": plan,
            "planStatus": plan_status,
            "preview": build_preview(tables),
            "report": report,
            "outputSchemas": _schemas_of(tables),
        }

    # Stored plan, no feedback: fit -> execute without any LLM.
    if stored_plan and not feedback:
        fit = fit_parse_plan(grids, stored_plan)
        if fit["verdict"] == "fit":
            result = exec_plan(stored_plan)
            tables, report = result["tables"], result["report"]
            return {
                "plan": stored_plan,
                "planStatus": "stored",
                "preview": build_preview(tables),
                "report": report,
                "outputSchemas": _schemas_of(tables),
            }
        amended = propose_with_self_check(existing_plan=stored_plan, fit_detail=fit["detail"])
        return amended or {"planStatus": "none"}

    # Fresh proposal, or feedback revision of the current plan.
    proposed = propose_with_self_check(
        existing_plan=(stored_plan if feedback else None),
        feedback=feedback,
    )
    return proposed or {"planStatus": "none"}
