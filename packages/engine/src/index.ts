export { parseSectionText, spansFromInline } from "./dialect.js";
export { buildSourcePack, packForPrompt } from "./sourcePack.js";
export type { ParsedTable, PackedSource, SourcePack, EngineFile } from "./sourcePack.js";
export { evaluateAssert, auditCitations, countCitations } from "./checks.js";
export type { CheckOutcome } from "./checks.js";
