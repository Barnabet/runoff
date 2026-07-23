"""Placeholder for the copilotTables.test.ts port.

`copilot.ts` exports only TypeScript interfaces / type-alias unions
(`MastheadPatch`, `EditOp`, `CopilotAction`, `MemoryRow`, `GoldenRow`) — no zod
schemas, no runtime constants, and no pure functions. Per the Porting Contract,
type-only exports have no Python equivalent (the dict IS the runtime shape), so
there is nothing in `copilot.py` to validate here.

The named TS test file, `copilotTables.test.ts`, exercises the boot DDL
(`copilot_messages` / `memories` / `goldens` tables and their column defaults),
which is Task 1 territory and is already covered by
`test_db.py::test_open_db_creates_all_tables` and the default-column assertions
there. Both of its cases are therefore skipped in this module.
"""

import pytest


@pytest.mark.skip(reason="DB DDL case — covered by test_db.py (Task 1), not copilot.py types")
def test_boot_ddl_creates_copilot_messages_memories_goldens():
    ...
