# Runoff R1 — API Contract + Python Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `backend/` — a FastAPI application implementing every non-LLM/non-upload/non-SSE endpoint against the same `data/runoff.db` — plus the complete written v1 API contract, verified against the TS implementation by ported pytest suites, cross-implementation fixtures, and a route-pair diff harness.

**Architecture:** Python 3.12 backend under `backend/` with `runoff_api/core/` (statement-for-statement port of `packages/core`, read side of the warehouse), `runoff_api/services/` (ports of the `apps/web/lib` server helpers the R1 routes use), and `runoff_api/api/` (FastAPI routers mirroring the Next.js route handlers). The Python backend runs dark on port 8400; Next.js keeps serving users unchanged. The DB is shared: a run enqueued by Python is executed by the existing TS worker.

**Tech Stack:** Python ≥3.12 via uv; FastAPI + Pydantic v2 + stdlib `sqlite3`; pytest + httpx (TestClient); ruff. TS side gains only additive scripts (`scripts/dump-parity-fixtures.ts`, `scripts/diff-api.ts`) and root `package.json` script lines.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-runoff-r1-api-contract-python-core-design.md`. R1 endpoint set = spec §3.2 rows tagged R1. No LLM calls, no file uploads, no SSE implementation, no Next.js production-code changes, no schema changes.
- **Same DB file:** default `data/runoff.db`, env var `RUNOFF_DB`; warehouses at `RUNOFF_WAREHOUSE_DIR` default `data/warehouses`; files at `RUNOFF_FILES_DIR` default `data/files`. Paths resolve exactly like the TS side (relative to the process CWD, which is the repo root for all `pnpm backend:*` scripts).
- **DDL byte-copy:** the `CREATE TABLE` DDL and the `sources_slot` index statement are byte-copied from `packages/core/src/db/index.ts` (NOT from `db/schema.ts`, which is a drizzle mirror the Python side does not need). Header comment in `db.py` marks it as a lockstep mirror.
- **Wire/DB JSON is camelCase**, byte-compatible with what TS writes. All JSON written to the DB or the wire uses `to_json()` (`json.dumps(..., separators=(",", ":"), ensure_ascii=False)`) — matches `JSON.stringify` framing.
- **Plain-dict runtime:** documents, events, inventories, catalogs, projections flow as plain dicts/lists with camelCase keys (exactly like the TS runtime, where types are compile-time only). Pydantic models exist to validate at the same call sites where the TS code calls `zod .parse/.safeParse` — nowhere else. SQL row → response passthrough keeps the TS column aliases (`client_name AS clientName`), so `dict(row)` is already wire-shaped.
- **Manual body validation:** routers read the raw body (`await request.json()` → on failure return 400 `{"error": "invalid JSON body"}`) and validate field-by-field, mirroring the TS handlers. Do NOT use FastAPI typed-body parameters (their automatic 422s would break error parity).
- **Errors:** `{"error": "<message>"}` with the exact message strings and status codes of the corresponding TS handler.
- **Port 8400** via `pnpm backend:dev`; tests via `pnpm backend:test`. uv manages the environment (`backend/pyproject.toml`, `requires-python >= 3.12`).
- **TS suite stays 501 green**; `pnpm test` must pass unchanged after every task.
- Python naming: snake_case functions/modules mirroring their TS origins (`newId` → `new_id`, `getRunPayload` → `get_run_payload`).

## Porting Contract (applies to every "port" step)

The TS source file named in the step **is the requirements document**. Port statement-for-statement: same SQL strings (including column aliases), same branch structure, same error messages, same caps/limits/regexes. Where TS idiom has no direct Python equivalent, the step names the mapping. Port the named TS test file case-by-case: same test names (snake_cased), same inputs, same expected values; skip only cases that exercise code R1 does not port, and list every skip in your report. When the TS source and this plan's prose disagree, the TS source wins — note the discrepancy in your report.

TS → Python mappings used throughout:

| TS | Python |
|---|---|
| `better-sqlite3` `Database` | `sqlite3.Connection` (`row_factory = sqlite3.Row`, `isolation_level=None`, `check_same_thread=False`) |
| `stmt.get(...)` / `.all(...)` | `conn.execute(sql, params).fetchone()` / `.fetchall()` |
| `db.sqlite.transaction(fn)(); ` | `conn.execute("BEGIN")` … `conn.execute("COMMIT")` with `except: conn.execute("ROLLBACK"); raise` |
| `tx.immediate()` | `conn.execute("BEGIN IMMEDIATE")` … as above |
| `stmt.run(...).changes` | `cur = conn.execute(...); cur.rowcount` |
| `JSON.stringify(x)` | `to_json(x)` |
| `JSON.parse(x)` | `json.loads(x)` |
| `?? null` / optional chaining | explicit `None` checks |
| `crypto.randomUUID().replaceAll("-","").slice(0,12)` | `uuid.uuid4().hex[:12]` |

---

## File Map

```
backend/
  pyproject.toml
  runoff_api/
    __init__.py
    main.py                     # create_app factory, router mounting     (T6)
    deps.py                     # get_db dependency, err() helper         (T6)
    core/
      __init__.py
      db.py                     # open_db + byte-copied DDL               (T1)
      ids.py                    # new_id                                  (T1)
      jsonutil.py               # to_json                                 (T1)
      reducer.py                # reduce_run                              (T3)
      dialect.py                # spans_from_inline, parse_section_text   (T3)
      bindings.py               # parse_bindings, boundness_counts        (T3)
      diff.py                   # parse_figure, diff_runs                 (T3)
      warehouse.py              # READ SIDE ONLY                          (T4)
      warehouse_catalog.py      # build_warehouse_catalog                 (T4)
      previous_run.py           # previous_completed_document             (T4)
      types/
        __init__.py
        base.py                 # CamelModel / CamelModelOpen             (T2)
        document.py  events.py  blueprint.py  sources.py                 (T2)
        parse_plan.py  catalog.py  golden_binding.py  copilot.py         (T2)
    services/
      __init__.py
      queries.py                # list_projects, payloads, blueprints     (T6)
      source_manager.py         # list_project_sources (read part)        (T6)
      run_options.py            # get_run_options                         (T6)
      query_row_counts.py       # compute_query_row_counts                (T6)
      goldens.py                # golden row access + resolve_golden      (T5)
      golden_binding.py         # verify_inventory & friends (non-LLM)    (T5)
      golden_pipeline.py        # rebuild/verify stored inventories       (T5)
    api/
      __init__.py
      projects.py  blueprints.py  goldens.py  runs.py  memories.py  flags.py   (T6 GETs, T7 writes)
  tests/
    conftest.py                                                          (T1)
    fixtures/                   # written by dump-parity-fixtures        (T9)
    test_db.py test_ids.py                                              (T1)
    test_types_*.py                                                     (T2)
    test_reducer.py test_dialect.py test_bindings.py test_diff.py       (T3)
    test_warehouse.py test_warehouse_catalog.py test_previous_run.py    (T4)
    test_golden_binding.py test_goldens_service.py                      (T5)
    test_api_manifest.py test_api_reads.py                              (T6)
    test_api_writes.py                                                  (T7)
    test_parity_fixtures.py                                             (T9)
docs/api/v1.md                                                          (T8)
scripts/dump-parity-fixtures.ts  scripts/diff-api.ts                    (T9)
```

---

### Task 1: Backend scaffold, DB layer, ids

**Files:**
- Create: `backend/pyproject.toml`, `backend/runoff_api/__init__.py`, `backend/runoff_api/core/__init__.py`, `backend/runoff_api/core/db.py`, `backend/runoff_api/core/ids.py`, `backend/runoff_api/core/jsonutil.py`, `backend/tests/conftest.py`, `backend/tests/test_db.py`, `backend/tests/test_ids.py`
- Modify: root `package.json` (scripts only), root `.gitignore`
- Reference (read, do not modify): `packages/core/src/db/index.ts`, `packages/core/src/ids.ts`, `packages/core/test/db.test.ts`

**Interfaces:**
- Produces: `open_db(path: str) -> sqlite3.Connection`; `new_id(prefix: str) -> str`; `to_json(value) -> str`; conftest fixture `db` (fresh temp DB connection); type alias `RunoffDb = sqlite3.Connection` exported from `db.py`. Every later task consumes these.

- [ ] **Step 1: Write `backend/pyproject.toml`**

```toml
[project]
name = "runoff-api"
version = "0.1.0"
description = "Runoff backend (R1+): FastAPI port of the TS backend"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn>=0.30",
    "pydantic>=2.8",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "httpx>=0.27",
    "ruff>=0.6",
]

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 110
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```

Create empty `backend/runoff_api/__init__.py` and `backend/runoff_api/core/__init__.py`.

- [ ] **Step 2: Root wiring**

Add to root `package.json` scripts (keep existing lines untouched):

```json
"backend:dev": "set -a; [ -f .env ] && . ./.env; set +a; RUNOFF_DB=$PWD/data/runoff.db RUNOFF_FILES_DIR=$PWD/data/files RUNOFF_WAREHOUSE_DIR=$PWD/data/warehouses uv --directory backend run uvicorn runoff_api.main:app --port 8400",
"backend:test": "uv --directory backend run pytest -q",
"backend:lint": "uv --directory backend run ruff check ."
```

Add to root `.gitignore`: `backend/.venv/`, `backend/**/__pycache__/`, `backend/.pytest_cache/`, `backend/uv.lock` is NOT ignored (commit it).

- [ ] **Step 3: Write failing tests**

`backend/tests/conftest.py`:

```python
import sqlite3

import pytest

from runoff_api.core.db import open_db


@pytest.fixture()
def db(tmp_path) -> sqlite3.Connection:
    conn = open_db(str(tmp_path / "test.db"))
    yield conn
    conn.close()
```

`backend/tests/test_ids.py`:

```python
import re

from runoff_api.core.ids import new_id


def test_new_id_format():
    got = new_id("bp")
    assert re.fullmatch(r"bp_[0-9a-f]{12}", got)
    assert new_id("bp") != new_id("bp")
```

`backend/tests/test_db.py` — port every case from `packages/core/test/db.test.ts` (read it first), plus these three:

```python
import sqlite3

from runoff_api.core.db import open_db


def test_open_db_creates_all_tables(db):
    names = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {
        "projects", "source_families", "blueprint_families", "blueprints",
        "blueprint_revisions", "sources", "runs", "run_events", "run_inputs",
        "flags", "notes", "copilot_messages", "memories", "goldens",
    } <= names


def test_open_db_rejects_pre_v12b_database(tmp_path):
    path = tmp_path / "old.db"
    legacy = sqlite3.connect(str(path))
    legacy.execute("CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
    legacy.commit()
    legacy.close()
    try:
        open_db(str(path))
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "predates v1.2b" in str(e)


def test_sqlite3_module_is_serialized():
    # Sync endpoints run in a threadpool sharing one connection (same model as
    # better-sqlite3's single handle); requires a serialized sqlite3 build.
    assert sqlite3.threadsafety == 3
```

- [ ] **Step 4: Run tests, confirm failure**

Run: `pnpm backend:test` — Expected: import errors (modules don't exist). uv creates the venv on first run.

- [ ] **Step 5: Implement**

`backend/runoff_api/core/ids.py`:

```python
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"
```

`backend/runoff_api/core/jsonutil.py`:

```python
import json
from typing import Any


def to_json(value: Any) -> str:
    """JSON framing byte-compatible with JS JSON.stringify (compact, non-ASCII kept)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
```

`backend/runoff_api/core/db.py` — the DDL string below must be **byte-identical** to the `DDL` constant in `packages/core/src/db/index.ts` (copy it from the file, do not retype). Structure:

```python
import sqlite3
from pathlib import Path

# MIRROR of packages/core/src/db/index.ts — the DDL and open semantics change
# only in lockstep with that file. Schema is frozen during the R-phase port.

RunoffDb = sqlite3.Connection

DDL = """
CREATE TABLE IF NOT EXISTS projects (
...byte-copied from packages/core/src/db/index.ts...
"""


def open_db(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(DDL)
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM pragma_table_info('sources') WHERE name='family_id'"
    ).fetchone()["n"]
    if n == 0:
        conn.close()
        raise RuntimeError("database predates v1.2b — delete the DB file and run: pnpm seed")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS sources_slot ON sources(family_id, period) WHERE status='filed';"
    )
    return conn
```

- [ ] **Step 6: Run tests to verify pass** — `pnpm backend:test` → all green. Also `pnpm backend:lint` clean and `pnpm test` still 501.

- [ ] **Step 7: Commit**

```bash
git add backend/ package.json .gitignore
git commit -m "feat(backend): R1 scaffold — uv project, sqlite3 db layer with byte-copied DDL, ids"
```

---

### Task 2: Types port (Pydantic v2)

**Files:**
- Create: `backend/runoff_api/core/types/__init__.py`, `base.py`, `document.py`, `events.py`, `blueprint.py`, `sources.py`, `parse_plan.py`, `catalog.py`, `golden_binding.py`, `copilot.py`; `backend/tests/test_types_document.py`, `test_types_blueprint.py`, `test_types_sources.py`, `test_types_parse_plan.py`, `test_types_golden_binding.py`, `test_types_copilot.py`
- Reference: `packages/core/src/types/*.ts` (one Python module per TS file), `packages/core/test/types.test.ts`, `sourcesModel.test.ts`, `parsePlan.test.ts`, `goldenBinding.test.ts`, `copilotTables.test.ts`

**Interfaces:**
- Consumes: nothing beyond T1.
- Produces: Pydantic models named after their zod schemas minus the `Schema` suffix (`RunDocumentSchema` → `RunDocument`, `BindingInventorySchema` → `BindingInventory`, `BlueprintContentSchema` → `BlueprintContent`, `ParsePlanSchema` → `ParsePlan`); runtime helpers `blocks_to_plain_text(blocks: list[dict]) -> str`, `count_words(blocks: list[dict]) -> int` in `document.py`; constants ported verbatim (`PERIOD_REGEX` as `dict[str, re.Pattern]`, `plan_table_name(...)` from `parsePlan.ts`, and every other exported constant/pure function in the types files). Later tasks call `Model.model_validate(data)` where TS calls `Schema.parse(data)`.

- [ ] **Step 1: Write `base.py`**

```python
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """zod `.strict()` equivalent: unknown keys rejected; camelCase wire aliases."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class CamelModelOpen(BaseModel):
    """zod default (non-strict) equivalent: unknown keys ignored."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
```

Serialization rule (record it as a module docstring in `base.py`): when a validated model must be re-serialized (e.g. revisions POST), use `model_dump(by_alias=True, exclude_unset=True)` — optional fields absent from the input stay absent, explicit nulls stay null, matching zod round-trip semantics. Fields with zod `.default()` must be passed explicitly at construction sites.

- [ ] **Step 2: Write the failing type tests**

Port the named TS test files case-by-case (Porting Contract). Anchor example for `test_types_document.py` — the rest follow the same pattern from their TS sources:

```python
import pytest
from pydantic import ValidationError

from runoff_api.core.types.document import RunDocument, blocks_to_plain_text


def _doc(sections):
    return {"title": "T", "eyebrow": "E", "dateline": "D", "sections": sections}


def test_run_document_rejects_duplicate_section_keys():
    doc = _doc([
        {"key": "cash", "heading": "Cash", "blocks": []},
        {"key": "cash", "heading": "Cash 2", "blocks": []},
    ])
    with pytest.raises(ValidationError, match="duplicate section key: cash"):
        RunDocument.model_validate(doc)


def test_run_document_rejects_unknown_keys():
    doc = _doc([])
    doc["extra"] = 1
    with pytest.raises(ValidationError):
        RunDocument.model_validate(doc)


def test_blocks_to_plain_text_joins_tables_with_middle_dot():
    blocks = [
        {"type": "paragraph", "spans": [{"text": "Hi "}, {"text": "there", "citation": {"sourceId": "f", "locator": "l"}}]},
        {"type": "table", "columns": ["A"], "rows": [{"cells": [[{"text": "1"}, {"text": "2"}]]}]},
    ]
    assert blocks_to_plain_text(blocks) == "Hi there\n\n12"
```

(Check the exact `blocksToPlainText` join semantics against the TS source — cells join with `""`, cells within a row with `" · "`, rows with `"\n"`, blocks with `"\n\n"` — and assert accordingly.)

- [ ] **Step 3: Run tests, confirm failure** — `pnpm backend:test`.

- [ ] **Step 4: Implement the type modules**

`document.py` in full (pattern for all others):

```python
import re
from typing import Annotated, Literal, Optional, Union

from pydantic import Field, model_validator

from .base import CamelModel

KEY_RE = r"^[a-z][a-z0-9_]*$"


class Citation(CamelModel):
    source_id: str = Field(min_length=1)
    locator: str = Field(min_length=1)


class Span(CamelModel):
    text: str
    citation: Optional[Citation] = None


class ParagraphBlock(CamelModel):
    type: Literal["paragraph"]
    spans: list[Span]


class TableRowModel(CamelModel):
    cells: list[list[Span]]


class TableBlock(CamelModel):
    type: Literal["table"]
    columns: list[str]
    rows: list[TableRowModel]


Block = Annotated[Union[ParagraphBlock, TableBlock], Field(discriminator="type")]


class DocSection(CamelModel):
    key: str = Field(pattern=KEY_RE)
    heading: str = Field(min_length=1)
    blocks: list[Block]


class RunDocument(CamelModel):
    title: str
    eyebrow: str
    dateline: str
    sections: list[DocSection]

    @model_validator(mode="after")
    def _unique_section_keys(self) -> "RunDocument":
        seen: set[str] = set()
        for s in self.sections:
            if s.key in seen:
                raise ValueError(f"duplicate section key: {s.key}")
            seen.add(s.key)
        return self


def blocks_to_plain_text(blocks: list[dict]) -> str:
    """Port of blocksToPlainText — operates on plain dicts (runtime shape)."""
    out = []
    for b in blocks:
        if b["type"] == "paragraph":
            out.append("".join(s["text"] for s in b["spans"]))
        else:
            out.append("\n".join(
                " · ".join("".join(s["text"] for s in cell) for cell in row["cells"])
                for row in b["rows"]
            ))
    return "\n\n".join(out)


def count_words(blocks: list[dict]) -> int:
    return len([w for w in re.split(r"\s+", blocks_to_plain_text(blocks)) if w])
```

For each remaining TS types file: port every exported zod schema to a model (strict → `CamelModel`, non-strict → `CamelModelOpen`), every exported constant (e.g. `PERIOD_REGEX` — copy the regex literals exactly), and every exported pure function (e.g. `planTableName`). `events.py` needs only the `RunEvent` discriminated union and `RunStats` (the reducer consumes dicts; the models exist for validation completeness and later phases). `catalog.py`: `CatalogFamily`, `CatalogTable`. `golden_binding.py`: the full v1.5 family (`BindingAnchor`, `SubmittedItem`, `SubmittedInventory`, `BindingItem`, `BindingInventory`, …) exactly as in the TS file. Re-export everything from `types/__init__.py`.

- [ ] **Step 5: Run tests to verify pass** — `pnpm backend:test`; `pnpm backend:lint`.

- [ ] **Step 6: Commit** — `git commit -m "feat(backend): port core zod types to Pydantic v2 (camelCase wire aliases)"`

---

### Task 3: Pure-logic core port — reducer, dialect, bindings, diff

**Files:**
- Create: `backend/runoff_api/core/reducer.py`, `dialect.py`, `bindings.py`, `diff.py`; `backend/tests/test_reducer.py`, `test_dialect.py`, `test_bindings.py`, `test_diff.py`
- Reference: `packages/core/src/{reducer,dialect,bindings,diff}.ts` and `packages/core/test/{reducer,bindings,diff}.test.ts` (dialect is covered inside `packages/engine/test/dialect.test.ts` — port the cases that exercise `spansFromInline`/`parseSectionText`)

**Interfaces:**
- Consumes: `blocks_to_plain_text` (T2), `BindingInventory` model (T2).
- Produces:
  - `reduce_run(events: list[dict], section_meta: list[dict]) -> dict` — projection dict with camelCase keys (`typedText`, `memoryIds`, …); `document`/`stats`/`error` keys present only once set.
  - `spans_from_inline(text: str) -> list[dict]`, `parse_section_text(raw: str) -> list[dict]` — span dicts carry a `citation` key ONLY when a citation exists (matches TS object shape).
  - `parse_bindings(raw: str | None) -> dict | None` (validates via `BindingInventory`, returns the **plain dict** `model_dump(by_alias=True, exclude_unset=True)`; corrupt/drifted → `None`), `boundness_counts(inv: dict | None) -> dict | None` (`{"bound": n, "mismatch": n, "total": n}`).
  - `parse_figure(text: str) -> float`, `diff_runs(current: dict, previous: dict) -> dict` (`{"deltas": [...], "sections": {...}}`).

- [ ] **Step 1: Port the four TS test files** (Porting Contract; reducer's tests replay event lists — transcribe them as dict literals). Include this Python-specific case in `test_reducer.py`:

```python
def test_projection_omits_unset_optional_keys():
    p = reduce_run([], [])
    assert "document" not in p and "stats" not in p and "error" not in p
```

- [ ] **Step 2: Run, confirm failure.** `pnpm backend:test`
- [ ] **Step 3: Port the four modules statement-for-statement.** `bindings.py` in full:

```python
from pydantic import ValidationError

from .types.golden_binding import BindingInventory
import json


def parse_bindings(raw: str | None) -> dict | None:
    """Corrupt/schema-drifted stored bindings degrade to None (v1.5 contract)."""
    if not raw:
        return None
    try:
        return BindingInventory.model_validate(json.loads(raw)).model_dump(by_alias=True, exclude_unset=True)
    except (ValidationError, ValueError):
        return None


def boundness_counts(inv: dict | None) -> dict | None:
    if inv is None:
        return None
    items = inv["items"]
    bound = sum(1 for i in items if (i.get("binding") or {}).get("status") == "bound")
    mismatch = sum(1 for i in items if (i.get("binding") or {}).get("status") == "mismatch")
    return {"bound": bound, "mismatch": mismatch, "total": len(items)}
```

Reducer: one `match e["type"]:` (or if/elif) arm per TS `case`, same order, same log message strings (including `§ {key} failed — {error}` with the exact spacing), `phase_before_pause` closure variable, `DRAFTING §{number:02d}` phase strings. Dialect: port the `CITE` regex verbatim (`\[\[([^\]|]+)\|([^\]|]+)\|([^\]]+)\]\]` — use `re.finditer`), the manual cell splitter with its `[[…]]`-aware state machine, and the table-detection regex `^\|?[\s|:-]+\|?$`. Diff: `parse_figure` strips `[$,%]` then `float()` (mirror `parseFloat` semantics: on failure TS yields `NaN` — return `math.nan`, and `Number.isFinite` checks become `math.isfinite`); cited-figure keys `f"{sourceId}|{locator.strip()}"`, first-parseable-wins.

- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(backend): port reducer, dialect, bindings, diff (plain-dict runtime)"`

---

### Task 4: Warehouse read side, catalog, previous run

**Files:**
- Create: `backend/runoff_api/core/warehouse.py`, `warehouse_catalog.py`, `previous_run.py`; `backend/tests/test_warehouse.py`, `test_warehouse_catalog.py`, `test_previous_run.py`
- Reference: `packages/core/src/warehouse.ts` (READ-SIDE ONLY: `warehouseDir`, `warehousePath`, `openReadonly`, `readWarehouseTables`, `runWarehouseSql`, `formatSqlResult`, plus the `MAX_RESULT_ROWS = 200` / `MAX_RESULT_CHARS = 10_000` caps and the `q()` identifier quoter; do NOT port attach/applySchema/deleteRows/insertRows/computeDrift — those are R2 ingestion), `packages/core/src/warehouseCatalog.ts`, `packages/core/src/db/previousRun.ts`; tests `packages/core/test/warehouseCatalog.test.ts`, `previousRun.test.ts`, and the read-side cases of `warehouse.test.ts`

**Interfaces:**
- Consumes: `RunoffDb` (T1).
- Produces:
  - `warehouse_dir() -> str`, `warehouse_path(project_id: str) -> str`
  - `read_warehouse_tables(project_id: str, family_key: str) -> list[dict]` — `{"name", "columns": [{"name", "type"}], "rowCounts": {...}}`
  - `run_warehouse_sql(project_id: str, sql: str, period: str | None = None) -> dict` — `{"columns": [...], "rows": [[...], ...]}`; raises `RuntimeError("no data ingested yet")` when no warehouse file; raises on multi-statement SQL, on writes (query_only), and `RuntimeError("query references :period but no period was provided")`
  - `format_sql_result(res: dict) -> str` — byte-identical output to `formatSqlResult` incl. `(0 rows)` and `… truncated at {shown} of {total} rows`
  - `build_warehouse_catalog(db: RunoffDb, project_id: str) -> list[dict]` — CatalogFamily dicts (`queryable`, `tables`, `filedPeriods`)
  - `previous_completed_document(db: RunoffDb, blueprint_id: str, run_id: str, created_at: str) -> dict | None` — `{"runId", "completedAt", "document"}`

- [ ] **Step 1: Write failing tests.** Port the three named TS test files. Test warehouses are built directly in the test (create `tmp_path/"warehouses"/f"{project_id}.db"` with `sqlite3`, insert `fam_*` tables with and without a `_period` column), with `RUNOFF_WAREHOUSE_DIR` pointed at `tmp_path` via `monkeypatch.setenv`. Include these Python-side guards:

```python
def test_run_warehouse_sql_rejects_multi_statement(wh_project):
    with pytest.raises(Exception):
        run_warehouse_sql(wh_project, "SELECT 1; SELECT 2")


def test_run_warehouse_sql_requires_period_when_referenced(wh_project):
    with pytest.raises(RuntimeError, match="query references :period"):
        run_warehouse_sql(wh_project, 'SELECT * FROM fam_ar WHERE "_period" = :period')


def test_run_warehouse_sql_rejects_writes(wh_project):
    with pytest.raises(sqlite3.OperationalError):
        run_warehouse_sql(wh_project, "DELETE FROM fam_ar")
```

- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.** Key mappings: read-only open = `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` + `PRAGMA query_only = ON`, guarded by `os.path.exists` first (missing file → the `no data ingested yet` / `[]` behaviors). `:period` bound iff `re.search(r":period\b", sql)`, passed as `{"period": period}`. Reader detection: after `cur = conn.execute(sql, params)`, `cur.description is None` → `{"columns": [], "rows": []}`. Rows as `list[list]` (`[list(r) for r in cur.fetchall()]` with the default tuple row factory on this read-only connection — do NOT set `sqlite3.Row` here). `previous_completed_document` keeps the exact SQL including `ORDER BY created_at DESC, id DESC LIMIT 1` and the unparseable-document → `None` degradation.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(backend): warehouse read side, catalog builder, previous-run lookup"`

---

### Task 5: Golden services (non-LLM half of the golden pipeline)

**Files:**
- Create: `backend/runoff_api/services/__init__.py`, `services/goldens.py`, `services/golden_binding.py`, `services/golden_pipeline.py`; `backend/tests/test_golden_binding.py`, `test_goldens_service.py`
- Reference: `apps/web/lib/goldens.ts` (all of it except `scaffoldDigestFor` — that is R3), `apps/web/lib/goldenPipeline.ts` (ONLY `projectOf`, `execFor`, `queriesForBlueprint`, `rebuildRunGoldenInventory`, `verifyStoredInventory` — NOT `bindExemplar`/`unifyAndBindExemplar`, which are LLM/R3), `packages/engine/src/goldenBinding.ts` (ONLY `parseSpanNumber`, `verifyInventory`, `boundnessLine`, `inventoryFromCitations` — NOT `renderGoldenForPrompt`), `packages/engine/src/checks.ts` (ONLY `compileLocator`); tests `packages/engine/test/goldenBinding.test.ts` (the four ported functions' cases), `packages/engine/test/checks.test.ts` (the `compileLocator` cases), `packages/core/test/goldenBinding.test.ts` (already covered by T2 — skip here)

**Interfaces:**
- Consumes: `parse_bindings`, `boundness_counts` (T3), `run_warehouse_sql`, `format_sql_result`, `build_warehouse_catalog` (T4), `RunDocument` validation (T2).
- Produces (all plain-dict in/out):
  - `golden_binding.py`: `parse_span_number(text: str) -> float | None`; `verify_inventory(inv: dict, exec_fn, period: str | None, doc: dict | None = None) -> dict`; `boundness_line(inv: dict | None) -> str`; `inventory_from_citations(document: dict, catalog: list[dict], queries_for) -> dict`; `compile_locator(locator: str, catalog: list[dict]) -> dict` (`{"sql": str, "family": <catalog family dict>}`, raising `ValueError` with the TS error messages)
  - `goldens.py`: `SELECT` constant (byte-copied aliases), `list_goldens(db, blueprint_id) -> list[dict]`, `get_golden_row(db, id) -> dict | None`, `golden_label(g: dict) -> str`, `resolve_golden(db, golden_id) -> dict | None` (keys `id/kind/label/note/period/document/inventory/unifyError`; corrupt document or bindings degrade to `None` values, never raise)
  - `golden_pipeline.py`: `rebuild_run_golden_inventory(db, golden_id) -> None`, `verify_stored_inventory(db, golden_id) -> None`

- [ ] **Step 1: Port the named test cases** (Porting Contract). `verify_inventory` tests fake `exec_fn` as a closure returning canned `{"columns": [...], "rows": [[...]]}` dicts — mirror the TS fakes. Cover at minimum: value bound within tolerance (`max(0.005, 1%)`), value mismatch stamps `verifiedValue`, `:period` SQL with `period=None` → error `"golden has no period"`, table col/row-count mismatch messages, single-value shape error, `parse_span_number` money/`K/M/B`/percent/non-numeric cases, `boundness_line` all four output forms, `inventory_from_citations` anchor-derived ids + 60-item cap + covering-query selection.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** Notes: `numbersMatch` tolerance verbatim; `verify_inventory`'s error-reason truncation is `str(e).split("\n")[0][:200]` prefixed `sql error: `; `inventory_from_citations` table-covering regex `\b{table}\b` must `re.escape` nothing (table names are `fam_*`, safe) — keep the exactly-one-family rule. `resolve_golden` porting: the run/section document resolution reads `runs.document`, filters sections for kind `section`, empty-section list → `None` document; wrap ALL of it in try/except → degrade. `golden_pipeline.exec_for` returns a closure over `run_warehouse_sql(project_id, sql, period)`.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(backend): golden services — verify/inventory/resolve (non-LLM half)"`

---

### Task 6: FastAPI app + all R1 GET endpoints

**Files:**
- Create: `backend/runoff_api/main.py`, `deps.py`, `api/__init__.py`, `api/projects.py`, `api/blueprints.py`, `api/goldens.py`, `api/runs.py`, `api/memories.py`, `api/flags.py` (flags.py and memories.py hold only `router = APIRouter()` in this task — their routes are all writes, added in T7; main.py imports them now so the mounting loop never changes), `services/queries.py`, `services/source_manager.py`, `services/run_options.py`, `services/query_row_counts.py`; `backend/tests/test_api_manifest.py`, `test_api_reads.py`
- Reference: route files `apps/web/app/api/**` for every spec-§3.2 R1 GET; libs `apps/web/lib/queries.ts` (`listProjects`, `getProjectPayload`, `listBlueprintsWithRuns`, `getRunPayload` — NOT `buildCopilotContext`), `apps/web/lib/sourceManager.ts` (ONLY `listProjectSources`), `apps/web/lib/runOptions.ts`, `apps/web/lib/queryRowCounts.ts`

**Interfaces:**
- Consumes: everything from T1–T5.
- Produces: `create_app(db_path: str | None = None) -> FastAPI` (module-level `app = create_app()` for uvicorn); `deps.get_db(request) -> RunoffDb` (connection stored on `app.state.db`, opened from `db_path or os.environ.get("RUNOFF_DB", "data/runoff.db")`); `deps.err(status: int, message: str) -> JSONResponse`; services:
  - `queries.list_projects(db) -> list[dict]`
  - `queries.get_project_payload(db, id) -> dict | None`
  - `queries.list_blueprints_with_runs(db, project_id) -> list[dict]`
  - `queries.get_run_payload(db, id) -> dict | None`
  - `source_manager.list_project_sources(db, project_id) -> dict` (`{"families": [...], "unfiled": [...]}`)
  - `run_options.get_run_options(db, blueprint_id) -> dict | None`
  - `query_row_counts.compute_query_row_counts(db, project_id, content: dict) -> dict`

- [ ] **Step 1: Write the manifest test** (drives which routes exist — grows in T7):

```python
from fastapi.routing import APIRoute

from runoff_api.main import create_app

R1_READ_ROUTES = {
    ("GET", "/api/v1/projects"),
    ("GET", "/api/v1/projects/{id}"),
    ("GET", "/api/v1/projects/{id}/sources"),
    ("GET", "/api/v1/blueprints"),
    ("GET", "/api/v1/blueprints/{id}"),
    ("GET", "/api/v1/blueprints/{id}/run-options"),
    ("GET", "/api/v1/blueprints/{id}/memories"),
    ("GET", "/api/v1/blueprints/{id}/copilot"),
    ("GET", "/api/v1/blueprints/{id}/goldens"),
    ("GET", "/api/v1/runs/{id}"),
}


def test_route_manifest():
    app = create_app(db_path=":memory:")
    routes = {
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in route.methods
        if method != "HEAD"
    }
    assert routes == R1_READ_ROUTES
```

Note `GET /projects/{id}/sources` is implemented from `list_project_sources` (same payload the TS route returns — read `apps/web/app/api/projects/[id]/sources/route.ts` GET for the exact shape).

- [ ] **Step 2: Write failing endpoint tests** in `test_api_reads.py`, using a TestClient over a temp DB seeded per-test with raw SQL inserts (fixture `client` + `db`). One test per endpoint minimum, plus the listed behaviors:

```python
import pytest
from fastapi.testclient import TestClient

from runoff_api.main import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "api.db"))
    with TestClient(app) as c:
        yield c, app.state.db
```

Required assertions (derive exact expected values from the TS sources):
- `GET /api/v1/projects` returns `{"projects": [...]}` ordered `created_at DESC, id DESC`, each with `blueprintCount` and `lastActivityAt` (latest of runs/revisions, `None` when neither).
- `GET /api/v1/projects/{id}` → 404 `{"error": "project not found"}` when missing; else project header + `blueprints` (with `lastRun.openFlags`) + `families` + `unfiled` (proposal JSON-parsed or `None`) + `memories` (project scope only, `rowid DESC`).
- `GET /api/v1/blueprints` without `projectId` query param → 400 `{"error": "projectId is required"}`.
- `GET /api/v1/blueprints/{id}` → 404 when missing; else `blueprint` (aliased row incl. `projectId`), parsed `content`, `project` stub fallback `{"id": ..., "name": ""}` when the project row is gone, `families`, `boundFamilyIds`, `queryRowCounts` (`{}` when content is null; values `None` for failing queries).
- `GET /api/v1/blueprints/{id}/run-options` → 404 `{"error": "blueprint not found"}`; granularity/periods/constants shapes per `runOptions.ts` (latest period first).
- `GET /api/v1/blueprints/{id}/memories` → both scopes via the exact `WHERE blueprint_id = ? OR (scope='project' AND project_id = (SELECT ...))`, `rowid DESC`.
- `GET /api/v1/blueprints/{id}/copilot` → `{"messages": [...]}` with `actions` parsed (`[]` when null).
- `GET /api/v1/blueprints/{id}/goldens` → `{"goldens": [...]}` raw aliased rows (bindings stays a raw string).
- `GET /api/v1/runs/{id}` → 404 `{"error": "run not found"}`; full payload: `run` row, parsed `events` (ordered by seq), `flags` (options/resolution parsed), `sectionMeta` sorted by number from the PINNED revision, `sourceLabels` family-id→label, `blueprint`, `project` stub fallback, `content` masthead with delivery fallback, `previous` (insert a second completed run to assert), `memories` both scopes ordered `rowid`.

- [ ] **Step 3: Run, confirm failure.**
- [ ] **Step 4: Implement.** `deps.py`:

```python
import os

from fastapi import Request
from fastapi.responses import JSONResponse

from runoff_api.core.db import RunoffDb, open_db


def get_db(request: Request) -> RunoffDb:
    return request.app.state.db


def err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def default_db_path() -> str:
    return os.environ.get("RUNOFF_DB", "data/runoff.db")
```

`main.py`:

```python
from fastapi import FastAPI

from runoff_api.api import blueprints, flags, goldens, memories, projects, runs
from runoff_api.core.db import open_db
from runoff_api.deps import default_db_path


def create_app(db_path: str | None = None) -> FastAPI:
    app = FastAPI(title="Runoff API", version="1")
    app.state.db = open_db(db_path or default_db_path())
    for router in (projects.router, blueprints.router, goldens.router, runs.router, memories.router, flags.router):
        app.include_router(router, prefix="/api/v1")
    return app


app = create_app()
```

(`:memory:` passes through `open_db` fine — `Path(":memory:").parent` is `.`.) Complete `api/projects.py` GET half as the pattern every router follows:

```python
from fastapi import APIRouter, Depends

from runoff_api.core.db import RunoffDb
from runoff_api.deps import err, get_db
from runoff_api.services.queries import get_project_payload, list_projects

router = APIRouter()


@router.get("/projects")
def get_projects(db: RunoffDb = Depends(get_db)):
    return {"projects": list_projects(db)}


@router.get("/projects/{id}")
def get_project(id: str, db: RunoffDb = Depends(get_db)):
    payload = get_project_payload(db, id)
    if payload is None:
        return err(404, "project not found")
    return payload
```

Endpoints are **sync `def`** (threadpool + serialized sqlite3 — same single-handle model as better-sqlite3). Services port their TS namesakes statement-for-statement; row dicts via `dict(row)`; nested JSON columns parsed exactly where TS parses them. `list_project_sources` calls `read_warehouse_tables` (T4) for the `tables` roll-up (`rowCount` summed across periods).

- [ ] **Step 5: Run to verify pass**, lint, `pnpm test` still 501.
- [ ] **Step 6: Commit** — `git commit -m "feat(backend): FastAPI app + all R1 read endpoints with manifest guard"`

---

### Task 7: R1 write endpoints

**Files:**
- Modify: `backend/runoff_api/api/{projects,blueprints,goldens,runs,memories,flags}.py`, `backend/tests/test_api_manifest.py`
- Create: `backend/tests/test_api_writes.py`
- Reference: the corresponding TS route files (each router step names its file); `apps/web/lib/goldens.ts`, `golden_pipeline` services (T5)

**Interfaces:**
- Consumes: T5 services (`rebuild_run_golden_inventory`, `verify_stored_inventory`, `get_golden_row`), `run_options.get_run_options` (T6), `new_id`, `to_json`, `BlueprintContent` model (T2), `PERIOD_REGEX` (T2).
- Produces: the write routes below; manifest set becomes `R1_ROUTES = R1_READ_ROUTES | R1_WRITE_ROUTES`.

- [ ] **Step 1: Extend the manifest test** with:

```python
R1_WRITE_ROUTES = {
    ("POST", "/api/v1/projects"),
    ("PATCH", "/api/v1/projects/{id}"),
    ("POST", "/api/v1/blueprints"),
    ("PATCH", "/api/v1/blueprints/{id}"),
    ("POST", "/api/v1/blueprints/{id}/revisions"),
    ("POST", "/api/v1/blueprints/{id}/goldens"),
    ("PATCH", "/api/v1/goldens/{id}"),
    ("DELETE", "/api/v1/goldens/{id}"),
    ("PATCH", "/api/v1/memories/{id}"),
    ("DELETE", "/api/v1/memories/{id}"),
    ("POST", "/api/v1/flags/{id}"),
    ("POST", "/api/v1/runs"),
    ("POST", "/api/v1/runs/{id}/inputs"),
}
```

- [ ] **Step 2: Write failing write tests.** Port each TS route's behavior; the non-negotiable cases:
- projects POST: 400 invalid JSON body; 400 `name required` (trims); id prefix `proj_`. PATCH: 404 first, then body validation (order matters — mirror TS).
- blueprints POST: creates blueprint + revision 1 with the default schema-valid content in one transaction; 400s for missing name / missing projectId / unknown projectId. PATCH: partial column updates; `familyIds` replacement with 400 `unknown family for this project` and 400 `granularity differs among bound periodic families`; validation happens BEFORE any write.
- revisions POST: 404 unknown blueprint; 400 `{"error": "invalid blueprint content", "issues": [...]}` on schema-invalid content (assert `error` and that `issues` is a list — its element shape is implementation-specific, per contract); rev bump under `BEGIN IMMEDIATE`; response `{"rev": n}`.
- goldens POST (JSON star): 400 kind/runId validation messages verbatim; 404 `run not found for this blueprint` (also when the run belongs to another blueprint); period copied from the run; `rebuild_run_golden_inventory` invoked (assert bindings column got written for a run with a cited document); multipart content-type → **501** `{"error": "exemplar upload not yet implemented in this backend (R3)"}` (documented R1-only divergence: the TS route implements it; the contract doc tags the multipart variant R3).
- goldens PATCH: invalid period 400 `invalid period: {period}`; 404; exemplar kind → `verify_stored_inventory`, run/section kind → `rebuild_run_golden_inventory`; response `{"golden": <row>}`. DELETE: 404; row deleted; stored file unlinked best-effort (`RUNOFF_FILES_DIR`), missing file tolerated.
- memories PATCH: 400 `status must be 'active' or 'disabled'`; 404 via `rowcount == 0`. DELETE likewise.
- flags POST: 400 `option is required`; 404; resolution JSON written compact; `{"remainingOpen": n}` counts the same run's open flags.
- runs POST: 404 `blueprint not found`; period validity via `get_run_options` (constants-only blueprint requires `period=None`; periodic requires a listed period) → 400 `period not available for this blueprint`; inserts `status='queued'` with the pinned `current_rev`; id prefix `run_`.
- run inputs POST: 400 kind validation message verbatim; 404 `run not found`; the answer-replacement UPDATE (`consumed_at IS NULL AND json_extract(payload, '$.questionId') = ?`) replaces a pending answer instead of inserting a second row — assert row count stays 1 and payload updated; other kinds always insert.

- [ ] **Step 3: Run, confirm failure.**
- [ ] **Step 4: Implement**, mirroring each TS route file top-to-bottom. `api/runs.py` write half in full (the cross-language flagship):

```python
import json

from fastapi import Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.deps import err, get_db
from runoff_api.services.run_options import get_run_options

INPUT_KINDS = {"pause", "resume", "steer", "answer"}


@router.post("/runs")
async def create_run(request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    blueprint_id = body.get("blueprintId") if isinstance(body.get("blueprintId"), str) else ""
    period = body.get("period") if isinstance(body.get("period"), str) else None

    bp = db.execute("SELECT current_rev AS currentRev FROM blueprints WHERE id = ?", (blueprint_id,)).fetchone()
    if bp is None:
        return err(404, "blueprint not found")

    options = get_run_options(db, blueprint_id)
    valid = (period is None) if options["granularity"] is None else (
        period is not None and any(p["period"] == period for p in options["periods"])
    )
    if not valid:
        return err(400, "period not available for this blueprint")

    run_id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period) VALUES (?, ?, ?, 'queued', ?)",
        (run_id, blueprint_id, bp["currentRev"], period),
    )
    return {"id": run_id}


@router.post("/runs/{id}/inputs")
async def post_run_input(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    kind = body.get("kind")
    if not isinstance(kind, str) or kind not in INPUT_KINDS:
        return err(400, "kind must be one of pause|resume|steer|answer")
    if db.execute("SELECT id FROM runs WHERE id = ?", (id,)).fetchone() is None:
        return err(404, "run not found")

    payload = {}
    if isinstance(body.get("text"), str):
        payload["text"] = body["text"]
    if isinstance(body.get("questionId"), str):
        payload["questionId"] = body["questionId"]

    if kind == "answer" and "questionId" in payload:
        cur = db.execute(
            "UPDATE run_inputs SET payload = ? WHERE run_id = ? AND kind = 'answer' "
            "AND consumed_at IS NULL AND json_extract(payload, '$.questionId') = ?",
            (to_json(payload), id, payload["questionId"]),
        )
        if cur.rowcount > 0:
            return {"ok": True}
    db.execute(
        "INSERT INTO run_inputs (run_id, kind, payload) VALUES (?, ?, ?)",
        (id, kind, to_json(payload)),
    )
    return {"ok": True}
```

(Verify the tail of the TS inputs route for the exact insert/replace fall-through before assuming the above — the TS source wins.)

- [ ] **Step 5: Run to verify pass**, lint, `pnpm test` still 501.
- [ ] **Step 6: Commit** — `git commit -m "feat(backend): R1 write endpoints — CRUD, run enqueue, inputs, golden rebuild"`

---

### Task 8: The v1 contract document

**Files:**
- Create: `docs/api/v1.md`
- Reference: every file under `apps/web/app/api/**` (all 23 routes), `apps/web/lib/api.ts` (response-shape interfaces), spec §3

**Interfaces:** none produced in code; the doc's endpoint table must agree with `R1_ROUTES` in `test_api_manifest.py` (same paths, same phase tags as spec §3.2).

- [ ] **Step 1: Write the doc.** Structure: (1) contract rules verbatim from spec §3.1; (2) one subsection per endpoint — method, `/api/v1` path, phase tag (R1/R2/R3), request shape, response shape (transcribed from the TS handler + `api.ts` interfaces, with field-level nullability), status codes with their exact error strings; (3) SSE appendix documenting `GET /runs/:id/events` framing by reading `apps/web/app/api/runs/[id]/events/route.ts` (message framing, backlog replay, terminal close) and copilot POST streaming by reading `apps/web/app/api/blueprints/[id]/copilot/route.ts` (event names, payload shapes, terminal event) — exact `data:` line formats; (4) a "Divergences" section listing the single R1 divergence (multipart goldens POST → 501 until R3).
- [ ] **Step 2: Cross-check** — every path in `R1_ROUTES` appears in the doc tagged R1; every spec-§3.2 row appears exactly once; total distinct route paths = 23. Fix any mismatch (manifest/spec wins).
- [ ] **Step 3: Commit** — `git commit -m "docs(api): v1 contract — full 23-route surface, SSE framing, phase tags"`

---

### Task 9: Parity fixtures, diff harness, live cross-language smoke

**Files:**
- Create: `scripts/dump-parity-fixtures.ts`, `scripts/diff-api.ts`, `backend/tests/test_parity_fixtures.py`
- Modify: root `package.json` (add `backend:fixtures`, `backend:parity`, `backend:diff` scripts)

**Interfaces:**
- Consumes: TS `@runoff/core` exports (`openDb`, `reduceRun`, `diffRuns`, `parseBindings`, `boundnessCounts`, `buildWarehouseCatalog`, `previousCompletedDocument`); Python equivalents from T1–T6.
- Produces: `backend/tests/fixtures/{reducer,diff,bindings,catalog}.json`; scripts runnable via pnpm.

- [ ] **Step 1: Write `scripts/dump-parity-fixtures.ts`.** Opens `RUNOFF_DB ?? "data/runoff.db"` (requires a freshly seeded DB: `rm -f data/runoff.db* && pnpm seed` — note the glob, stale `-wal`/`-shm` sidecars break openDb). For the seeded blueprint: pick its latest completed run; dump to `backend/tests/fixtures/`:
  - `reducer.json`: `{ "sectionMeta": [...], "events": [...], "projection": reduceRun(events, sectionMeta) }` using the run's real event log,
  - `diff.json`: `{ "current": doc, "previous": prevDoc, "diff": diffRuns(current, previous) }` (skip with a console note + write `null` if no predecessor),
  - `bindings.json`: `{ "raw": <goldens.bindings string>, "parsed": parseBindings(raw), "counts": boundnessCounts(parsed) }` for the seeded bound golden,
  - `catalog.json`: `{ "projectId": ..., "catalog": buildWarehouseCatalog(db, projectId) }`.
  Add script: `"backend:fixtures": "set -a; [ -f .env ] && . ./.env; set +a; tsx scripts/dump-parity-fixtures.ts"`.
- [ ] **Step 2: Write `backend/tests/test_parity_fixtures.py`.** Each test loads its fixture and asserts the Python function over the fixture's **inputs** equals the fixture's recorded TS **output**, compared as parsed JSON after a deep key-sort. `catalog.json` additionally needs the live warehouse: `pytest.mark.skipif` the fixture dir or `RUNOFF_PARITY` env is absent — parity tests run via `"backend:parity": "RUNOFF_PARITY=1 RUNOFF_WAREHOUSE_DIR=$PWD/data/warehouses uv --directory backend run pytest -q -k parity"` from a seeded repo root. Normalize the one known representational gap in the comparison helper: Python `float` vs JS number formatting — compare numbers with `pytest.approx` (rel=1e-12) by walking the structures, everything else exact.
- [ ] **Step 3: Run the fixture round-trip.** `rm -f data/runoff.db* && pnpm seed && pnpm backend:fixtures && pnpm backend:parity` → all parity tests pass. Fix ports (not fixtures) on mismatch.
- [ ] **Step 4: Write `scripts/diff-api.ts`.** Reads `data/runoff.db` directly (via `@runoff/core` openDb) to enumerate seeded ids (all projects, blueprints, runs), then for each R1 GET pair — TS `http://localhost:3000/api/...` vs Python `http://localhost:8400/api/v1/...` (base URLs overridable via `TS_BASE`/`PY_BASE`) — fetches both, parses JSON, deep-sorts keys, diffs. Routes: `/projects`, `/projects/:id`, `/projects/:id/sources`, `/blueprints?projectId=`, `/blueprints/:id`, `/blueprints/:id/run-options`, `/blueprints/:id/memories`, `/blueprints/:id/copilot`, `/blueprints/:id/goldens`, `/runs/:id`. Prints one line per pair (`OK` / `DIFF <path>` with a unified diff of the pretty-printed JSON) and exits 1 on any diff. Add `"backend:diff": "tsx scripts/diff-api.ts"`.
- [ ] **Step 5: Run the diff harness.** Terminal A: `pnpm dev` (web on :3000 + TS worker). Terminal B: `pnpm backend:dev`. Then `pnpm backend:diff` → zero diffs. Investigate and fix the Python side for any diff (TS is the reference).
- [ ] **Step 6: Live cross-language smoke (spec success criterion 4).** With both stacks from Step 5 still running (TS worker polling, CLIProxyAPI up):

```bash
BP=$(sqlite3 data/runoff.db "SELECT id FROM blueprints LIMIT 1")
BODY=$(curl -s localhost:8400/api/v1/blueprints/$BP/run-options | python3 -c "
import json, sys
o = json.load(sys.stdin)
period = o['periods'][0]['period'] if o['granularity'] else None
print(json.dumps({'blueprintId': '$BP', 'period': period}))")
RUN=$(curl -s -X POST localhost:8400/api/v1/runs -H 'content-type: application/json' -d "$BODY" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
while sleep 2; do
  curl -s localhost:8400/api/v1/runs/$RUN | python3 -c "import json,sys; print(json.load(sys.stdin)['run']['status'])"
done
```

Expected: status `queued` → `running` → `complete` — a Python-enqueued run executed by the TS worker. Record the run id in the report.
- [ ] **Step 7: Full verification sweep.** `pnpm backend:test` (all suites), `pnpm backend:lint`, `pnpm test` (501), `pnpm backend:diff` (0 diffs), parity green. Confirm spec §9 criteria 1–5.
- [ ] **Step 8: Commit** — `git commit -m "feat(backend): parity fixtures, API diff harness, live TS-worker smoke"`

---

## Self-Review Notes (already applied)

- Spec §3.2 lists `POST /blueprints/:id/goldens` multipart as R3 while the single TS route serves both variants — the Python route must therefore answer multipart with an explicit 501 (T7) and the contract doc records the divergence (T8). This was chosen over silently omitting the route because content-type dispatch happens inside one path.
- Spec §6's "schema.py carries statements byte-copied from schema.ts" is corrected here: the authoritative DDL lives in `packages/core/src/db/index.ts` (schema.ts is a drizzle-only mirror). db.py mirrors db/index.ts; there is no separate schema.py. Noted for the spec at merge time.
- `GET /projects/{id}/sources` was tagged R1 in the spec and is included in T6 (it is a pure read of `list_project_sources`).
- The diff harness deliberately excludes write endpoints (spec §7.3) and `GET /runs/:id/events` (SSE, R2).
```
