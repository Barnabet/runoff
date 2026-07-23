"""Placeholder for the copilotTables.test.ts port.

`copilot.ts` exports only TypeScript interfaces / type-alias unions
(`MastheadPatch`, `EditOp`, `CopilotAction`, `MemoryRow`, `GoldenRow`) — no zod
schemas, no runtime constants, and no pure functions. Per the Porting Contract,
type-only exports have no Python equivalent (the dict IS the runtime shape), so
there is nothing in `copilot.py` to validate here.

The named TS test file, `copilotTables.test.ts`, exercises the boot DDL — the
`copilot_messages` / `memories` / `goldens` tables and the `memories` default
columns (`status` defaults 'active', `created_at` populated). That is Task 1 (db
layer) territory, not `copilot.py` types, so it is ported into `test_db.py`
instead: table existence in `test_db.py::test_open_db_creates_all_tables` and the
default-column behaviour in `test_db.py::test_memories_status_and_created_at_defaults`.
Nothing remains for this types module to test — this file is an intentional
no-op placeholder so the file map entry exists.
"""
