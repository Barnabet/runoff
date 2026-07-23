import copy

from pydantic import ValidationError

from runoff_api.core.types.parse_plan import (
    ExecReport,
    ParsePlan,
    plan_pattern,
    plan_table_name,
    validate_parse_plan,
)
from runoff_api.core.types.sources import ClassifyProposal

PLAN = {
    "version": 1,
    "tables": [
        {
            "name": "aging",
            "anchor": {"sheet": "ar_aging",
                       "headerSignature": ["customer", "status", "amount due ($)"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [{"column": "customer", "pattern": "^grand total$"}],
            "columns": [
                {"from": "customer", "name": "customer", "type": "TEXT"},
                {"from": "amount due ($)", "name": "amount_due", "type": "REAL", "parse": "currency"},
            ],
            "onPeriodMismatch": "keep",
        },
    ],
}


# Ports parsePlan.test.ts "ParsePlanSchema > accepts a valid plan and defaults onPeriodMismatch".
def test_accepts_a_valid_plan_and_defaults_on_period_mismatch():
    rest = {k: v for k, v in PLAN["tables"][0].items() if k != "onPeriodMismatch"}
    parsed = ParsePlan.model_validate({"version": 1, "tables": [rest]})
    assert parsed.tables[0].on_period_mismatch == "keep"


# Ports "ParsePlanSchema > rejects bad logical names and _period canonicals".
def test_rejects_bad_logical_names():
    bad = copy.deepcopy(PLAN)
    bad["tables"][0]["name"] = "Bad Name"
    try:
        ParsePlan.model_validate(bad)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


# Ports "validateParsePlan > passes the reference plan".
def test_validate_parse_plan_passes_reference_plan():
    validate_parse_plan(PLAN)


# Ports "validateParsePlan > rejects duplicate table names".
def test_rejects_duplicate_table_names():
    try:
        validate_parse_plan({"version": 1, "tables": [PLAN["tables"][0], PLAN["tables"][0]]})
        raise AssertionError("expected error")
    except ValueError as e:
        assert str(e) == "duplicate table name: aging"


# Ports "validateParsePlan > rejects duplicate canonical or from per table".
def test_rejects_duplicate_column_name():
    t = copy.deepcopy(PLAN["tables"][0])
    t["columns"].append({"from": "x", "name": "customer", "type": "TEXT"})
    try:
        validate_parse_plan({"version": 1, "tables": [t]})
        raise AssertionError("expected error")
    except ValueError as e:
        assert str(e) == "duplicate column name: aging.customer"


# Ports "validateParsePlan > rejects _period canonical".
def test_rejects_period_canonical():
    t = copy.deepcopy(PLAN["tables"][0])
    t["columns"] = [{"from": "p", "name": "_period", "type": "TEXT"}]
    try:
        validate_parse_plan({"version": 1, "tables": [t]})
        raise AssertionError("expected error")
    except ValueError:
        pass


# Ports "validateParsePlan > rejects unknown references and non-date periodColumn".
def test_rejects_unknown_references_and_non_date_period_column():
    a = copy.deepcopy(PLAN["tables"][0])
    a["exclude"] = [{"column": "nope", "pattern": "x"}]
    try:
        validate_parse_plan({"version": 1, "tables": [a]})
        raise AssertionError("expected error")
    except ValueError as e:
        assert str(e) == "unknown column reference: aging.nope"

    b = copy.deepcopy(PLAN["tables"][0])
    b["periodColumn"] = "customer"
    try:
        validate_parse_plan({"version": 1, "tables": [b]})
        raise AssertionError("expected error")
    except ValueError as e:
        assert str(e) == 'periodColumn must have parse "date": aging.customer'


# Ports "validateParsePlan > rejects invalid regex patterns".
def test_rejects_invalid_regex_patterns():
    t = copy.deepcopy(PLAN["tables"][0])
    t["exclude"] = [{"column": None, "pattern": "("}]
    try:
        validate_parse_plan({"version": 1, "tables": [t]})
        raise AssertionError("expected error")
    except ValueError as e:
        assert str(e) == "invalid pattern: aging.("


# Ports "validateParsePlan > tolerates a leading PCRE inline-flag group in patterns".
def test_tolerates_leading_pcre_inline_flag_group():
    t = copy.deepcopy(PLAN["tables"][0])
    t["exclude"] = [{"column": None, "pattern": "(?i)^grand total$"}]
    validate_parse_plan({"version": 1, "tables": [t]})
    re_ = plan_pattern("(?i)^grand total$")
    assert re_.search("Grand Total")
    assert not re_.search("acme corp")
    assert plan_pattern("^foo$").search("FOO")


# Ports "planTableName > single-table plan collapses to fam_<key>".
def test_plan_table_name_single_table():
    assert plan_table_name("ar_aging", PLAN, "aging") == "fam_ar_aging"


# Ports "planTableName > multi-table plan suffixes the logical name".
def test_plan_table_name_multi_table():
    second = copy.deepcopy(PLAN["tables"][0])
    second["name"] = "totals"
    multi = {"version": 1, "tables": [PLAN["tables"][0], second]}
    assert plan_table_name("ar_aging", multi, "totals") == "fam_ar_aging__totals"


# z.number() preserves int identity — ExecReport rowsKept=6 must dump back as 6, not 6.0.
def test_exec_report_int_counts_survive_round_trip_as_int():
    report = ExecReport.model_validate({"tables": [{
        "name": "aging", "anchor": {"sheet": "ar_aging", "row": 2}, "problems": [], "rowsKept": 6,
        "rowsExcluded": [], "coercionFailures": [], "periodMismatches": None, "unknownColumns": [],
    }]})
    dumped = report.model_dump(by_alias=True, exclude_unset=True)
    table = dumped["tables"][0]
    assert table["rowsKept"] == 6
    assert isinstance(table["rowsKept"], int) and not isinstance(table["rowsKept"], bool)
    assert isinstance(table["anchor"]["row"], int)


# Ports "ClassifyProposal plan fields > accepts plan/planStatus/preview/report".
def test_classify_proposal_accepts_plan_fields():
    ClassifyProposal.model_validate({
        "familyKey": "ar_aging", "period": "2026-Q2", "confidence": "high",
        "plan": PLAN, "planStatus": "proposed",
        "preview": {"tables": [{"name": "aging", "columns": ["customer"], "rows": [["Acme"]]}]},
        "report": {"tables": [{
            "name": "aging", "anchor": {"sheet": "ar_aging", "row": 2}, "problems": [], "rowsKept": 6,
            "rowsExcluded": [], "coercionFailures": [], "periodMismatches": None, "unknownColumns": [],
        }]},
    })
