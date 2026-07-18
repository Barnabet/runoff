import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const blueprints = sqliteTable("blueprints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  clientName: text("client_name").notNull().default(""),
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
  name: text("name").notNull(),
  kind: text("kind").notNull().default("file"),
  storedFilename: text("stored_filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  uploadedAt: text("uploaded_at").notNull().default(""),
  refreshedAt: text("refreshed_at"),
});

export const blueprintSources = sqliteTable("blueprint_sources", {
  blueprintId: text("blueprint_id").notNull(),
  sourceId: text("source_id").notNull(),
}, (t) => [primaryKey({ columns: [t.blueprintId, t.sourceId] })]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  blueprintRev: integer("blueprint_rev").notNull(),
  triggerKind: text("trigger_kind").notNull().default("manual"),
  status: text("status").notNull().default("queued"), // queued|running|paused|complete|failed
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
