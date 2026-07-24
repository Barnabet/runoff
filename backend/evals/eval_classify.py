"""Live smoke for classify_source against the local proxy — Python twin of
scripts/evalClassify.ts.

Sample the ga4 fixture and expect a valid proposal (any family/period — the
model's call), i.e. a non-null return. Exits 1 on null. Plain script, no pytest.
"""

import sys
from pathlib import Path

# Running as a script file puts only backend/evals/ on sys.path; add backend/ so
# the runoff_api package (backend/runoff_api) imports without an install step.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runoff_api.engine.classify import classify_source  # noqa: E402
from runoff_api.engine.llm import make_llm_client  # noqa: E402

# backend/evals/eval_classify.py -> repo root is parents[2]; fixtures are the
# same scripts/fixtures/ the TS eval reads.
FIXTURES = Path(__file__).resolve().parents[2] / "scripts" / "fixtures"


def main() -> None:
    client = make_llm_client()
    content_sample = (FIXTURES / "ga4_export.csv").read_text(encoding="utf-8")[:2000]
    p = classify_source(
        client=client,
        filename="ga4_export_q3.csv",
        content_sample=content_sample,
        families=[
            {"key": "marketing_spend", "label": "Marketing spend",
             "kind": "periodic", "granularity": "quarter"},
            {"key": "ga4_analytics", "label": "GA4 analytics", "kind": "periodic", "granularity": "quarter"},
            {"key": "brand_guidelines", "label": "Brand guidelines", "kind": "constant", "granularity": None},
        ],
    )
    if not p:
        print("EVAL CLASSIFY FAILED: null proposal", file=sys.stderr)
        sys.exit(1)
    period = p.get("period") if p.get("period") is not None else "constant"
    print(f"EVAL CLASSIFY OK: {p.get('familyKey')} · {period} · {p.get('confidence')}")


if __name__ == "__main__":
    main()
