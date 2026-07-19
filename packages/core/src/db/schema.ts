import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(""),
});

export const sourceFamilies = sqliteTable("source_families", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  kind: text("kind").notNull(), // periodic | constant
  granularity: text("granularity"), // quarter | month | year | null
  parsePlan: text("parse_plan"), // ParsePlan JSON
  createdAt: text("created_at").notNull().default(""),
});

export const blueprintFamilies = sqliteTable("blueprint_families", {
  blueprintId: text("blueprint_id").notNull(),
  familyId: text("family_id").notNull(),
}, (t) => [primaryKey({ columns: [t.blueprintId, t.familyId] })]);

export const blueprints = sqliteTable("blueprints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  clientName: text("client_name").notNull().default(""),
  projectId: text("project_id").notNull().default(""),
  cadenceLabel: text("cadence_label").notNull().default("Monthly"),
  status: text("status").notNull().default("draft"), // draft | active
  currentRev: integer("current_rev").notNull().default(0),
  createdAt: text("created_at").notNull().default(""),
});

export const blueprintRevisions = sqliteTable("blueprint_revisions", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  rev: integer("rev").notNull(),
  content: text("content").notNull(), // BlueprintContent JSON
  createdAt: text("created_at").notNull().default(""),
});

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().default(""),
  familyId: text("family_id"),
  period: text("period"),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("file"),
  storedFilename: text("stored_filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  status: text("status").notNull().default("unfiled"), // unfiled | filed | replaced
  proposal: text("proposal"), // ClassifyProposal JSON
  parseReport: text("parse_report"), // ExecReport JSON
  uploadedAt: text("uploaded_at").notNull().default(""),
  filedAt: text("filed_at"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  blueprintRev: integer("blueprint_rev").notNull(),
  triggerKind: text("trigger_kind").notNull().default("manual"),
  status: text("status").notNull().default("queued"), // queued|running|paused|complete|failed
  period: text("period"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  stats: text("stats"),       // RunStats JSON
  document: text("document"), // RunDocument JSON
  createdAt: text("created_at").notNull().default(""),
});

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(), // RunEvent JSON (whole event)
  createdAt: text("created_at").notNull().default(""),
});

export const runInputs = sqliteTable("run_inputs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(), // pause|resume|steer|answer
  payload: text("payload").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(""),
  consumedAt: text("consumed_at"),
});

export const flags = sqliteTable("flags", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  code: text("code").notNull(), // F1, F2…
  sectionKey: text("section_key").notNull(),
  question: text("question").notNull(),
  options: text("options").notNull(), // string[] JSON
  status: text("status").notNull().default("open"), // open|resolved
  resolution: text("resolution"), // { option, note? } JSON
  createdAt: text("created_at").notNull().default(""),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  sectionKey: text("section_key").notNull(),
  author: text("author").notNull(), // user | agent
  body: text("body").notNull(),
  proposedEdit: text("proposed_edit"), // ProposedEdit JSON
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull().default(""),
});

export const copilotMessages = sqliteTable("copilot_messages", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  role: text("role").notNull(),
  body: text("body").notNull(),
  actions: text("actions"), // CopilotAction[] JSON
  status: text("status").notNull().default("ok"),
  createdAt: text("created_at").notNull().default(""),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull().default("blueprint"), // blueprint | project
  projectId: text("project_id").notNull().default(""),
  blueprintId: text("blueprint_id"),
  body: text("body").notNull(),
  source: text("source").notNull(), // copilot | distilled
  originId: text("origin_id"),
  status: text("status").notNull().default("active"), // active | disabled
  createdAt: text("created_at").notNull().default(""),
});

export const goldens = sqliteTable("goldens", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  kind: text("kind").notNull(), // run | section | exemplar
  runId: text("run_id"),
  sectionKey: text("section_key"),
  name: text("name"),
  mime: text("mime"),
  storedFilename: text("stored_filename"),
  note: text("note"),
  period: text("period"),
  document: text("document"),       // RunDocument JSON
  unifyError: text("unify_error"),
  bindings: text("bindings"),       // BindingInventory JSON
  createdAt: text("created_at").notNull().default(""),
});
