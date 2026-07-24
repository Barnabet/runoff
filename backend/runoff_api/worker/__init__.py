"""Python worker — claims queued runs from the shared DB and executes them
through the engine. Port of apps/worker/src (runLoop.ts, resolveSources.ts,
runData.ts, index.ts). TS wins on every statement."""
