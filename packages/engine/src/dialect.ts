// The dialect parser lives in @runoff/core so the web client can render
// streaming drafts through the same AST; re-exported here for engine internals.
export { parseSectionText, spansFromInline } from "@runoff/core";
