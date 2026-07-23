"""Port of packages/core/src/types/copilot.ts.

copilot.ts exports only TypeScript interfaces and type-alias unions
(`MastheadPatch`, `EditOp`, `CopilotAction`, `MemoryRow`, `GoldenRow`) — no zod
schemas, no runtime constants, and no pure functions. Type-only exports have no
Python equivalent (the model IS the type; here there is no model to build): these
shapes flow as plain dicts at runtime, and the DB-row shapes (`MemoryRow`,
`GoldenRow`) come straight from SQL rows. Nothing to port at runtime.

Left intentionally empty so the module exists in the file map; later tasks that
need these shapes read/write plain camelCase dicts.
"""
