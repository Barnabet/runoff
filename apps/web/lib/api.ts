import type {
  BlueprintContent,
  ClassifyProposal,
  CopilotAction,
  Granularity,
  GoldenRow,
  MemoryRow,
  PreviousRun,
  ProjectSourceRow,
  RunEvent,
} from "@runoff/core";

// Client-side fetch helpers for the API routes. These run in the browser, so
// this module must never import server-only code (db, node:*).

export interface LastRun {
  id: string;
  finishedAt: string | null;
  status: string;
  openFlags: number;
}

export interface BlueprintListItem {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  sourceCount: number;
  lastRun: LastRun | null;
}

export interface BlueprintRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  createdAt: string;
}

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  storedFilename: string;
  mime: string;
  size: number;
  uploadedAt: string;
  usedBy?: number;
}

export type PatchBlueprintBody = Partial<{
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  sourceIds: string[];
}>;

const JSON_HEADERS = { "content-type": "application/json" };

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export function listBlueprints(projectId: string): Promise<{ blueprints: BlueprintListItem[] }> {
  return fetchJson(`/api/blueprints?projectId=${encodeURIComponent(projectId)}`);
}

export function createBlueprint(body: { name: string; clientName: string; projectId: string }): Promise<{ id: string }> {
  return fetchJson("/api/blueprints", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getBlueprint(
  id: string,
): Promise<{ blueprint: BlueprintRow; content: BlueprintContent; sources: SourceRow[]; project: { id: string; name: string } }> {
  return fetchJson(`/api/blueprints/${id}`);
}

// ---- Projects ---------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  name: string;
  blueprintCount: number;
  lastActivityAt: string | null;
}

export function listProjectsApi(): Promise<{ projects: ProjectListItem[] }> {
  return fetchJson("/api/projects");
}

export function createProject(body: { name: string }): Promise<{ id: string }> {
  return fetchJson("/api/projects", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function patchProject(id: string, body: { name: string }): Promise<{ ok: true }> {
  return fetchJson(`/api/projects/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getProject(id: string): Promise<{
  project: { id: string; name: string; createdAt: string };
  blueprints: BlueprintListItem[];
  families: FamilySummary[];
  unfiled: ProjectSourceRow[];
}> {
  return fetchJson(`/api/projects/${id}`);
}

// ---- Project source manager -------------------------------------------------

export interface FamilySummary {
  id: string;
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: Granularity | null;
  filedPeriods: string[];
  liveFile: { sourceId: string; name: string } | null;
}

export interface ProjectSourcesResponse {
  families: FamilySummary[];
  unfiled: ProjectSourceRow[];
}

export interface NewFamilyInput {
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: Granularity | null;
}

export interface FileSourceBody {
  familyId?: string;
  newFamily?: NewFamilyInput;
  period: string | null;
}

export function getProjectSources(projectId: string): Promise<ProjectSourcesResponse> {
  return fetchJson(`/api/projects/${projectId}/sources`);
}

export function uploadProjectSources(
  projectId: string,
  files: File[],
): Promise<{ sources: ProjectSourceRow[] }> {
  const fd = new FormData();
  for (const file of files) fd.append("files", file);
  return fetchJson(`/api/projects/${projectId}/sources`, { method: "POST", body: fd });
}

export function classifySources(
  projectId: string,
  sourceIds: string[],
): Promise<{ sources: { id: string; proposal: ClassifyProposal | null }[] }> {
  return fetchJson(`/api/projects/${projectId}/sources/classify`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sourceIds }),
  });
}

export function confirmSource(
  projectId: string,
  body: FileSourceBody & { sourceId: string },
): Promise<{ ok: true }> {
  return fetchJson(`/api/projects/${projectId}/sources/confirm`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function refileSource(
  projectId: string,
  sourceId: string,
  body: FileSourceBody,
): Promise<{ ok: true }> {
  return fetchJson(`/api/projects/${projectId}/sources/${sourceId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function deleteProjectSource(projectId: string, sourceId: string): Promise<{ ok: true }> {
  return fetchJson(`/api/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" });
}

export function patchBlueprint(id: string, body: PatchBlueprintBody): Promise<{ ok: true }> {
  return fetchJson(`/api/blueprints/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function saveRevision(id: string, content: BlueprintContent): Promise<{ rev: number }> {
  return fetchJson(`/api/blueprints/${id}/revisions`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
}

export function listSources(): Promise<{ sources: SourceRow[] }> {
  return fetchJson("/api/sources");
}

export function uploadSource(file: File, name: string): Promise<{ id: string }> {
  const fd = new FormData();
  fd.set("file", file);
  fd.set("name", name);
  return fetchJson("/api/sources", { method: "POST", body: fd });
}

export function deleteSource(id: string): Promise<{ ok: true }> {
  return fetchJson(`/api/sources/${id}`, { method: "DELETE" });
}

export function refreshSource(id: string): Promise<{ ok: true }> {
  return fetchJson(`/api/sources/${id}`, { method: "POST" });
}

// ---- Runs, flags ------------------------------------------------------------

export interface RunRow {
  id: string;
  blueprintId: string;
  blueprintRev: number;
  triggerKind: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: string | null;
  document: string | null;
  createdAt: string;
}

export interface FlagRow {
  id: string;
  runId: string;
  code: string;
  sectionKey: string;
  question: string;
  options: string[];
  status: string;
  resolution: { option: string; note?: string } | null;
  createdAt: string;
}

export interface SectionMeta {
  key: string;
  number: number;
  heading: string;
}

export interface GetRunResponse {
  run: RunRow;
  events: RunEvent[];
  flags: FlagRow[];
  sectionMeta: SectionMeta[];
  sourceLabels: Record<string, string>;
  blueprint: { id: string; name: string; clientName: string };
  // The owning project, so the Reader can back-link to it.
  project: { id: string; name: string };
  // The pinned revision's masthead, so the Live Run page can render the document
  // header before any section has been drafted; plus its delivery settings so the
  // Reader can render the status banner and DELIVERY card.
  content: {
    title: string;
    eyebrow: string;
    dateline: string;
    delivery: { recipient: string; autoDeliverOnClear: boolean };
  };
  // The latest completed predecessor run of the same blueprint (document +
  // completion date), or null for a first run. The Reader diffs against it;
  // the Live page ignores it.
  previous: PreviousRun | null;
  // Every memory for the blueprint (id + body). The Reader filters these to the
  // run's `memoryIds` to show which standing notes shaped this run.
  memories: { id: string; body: string }[];
}

export type RunInput = { kind: "pause" | "resume" | "steer" | "answer"; text?: string; questionId?: string };

export function createRun(blueprintId: string): Promise<{ id: string }> {
  return fetchJson("/api/runs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ blueprintId }) });
}

export function getRun(id: string): Promise<GetRunResponse> {
  return fetchJson(`/api/runs/${id}`);
}

export function postRunInput(id: string, input: RunInput): Promise<{ ok: true }> {
  return fetchJson(`/api/runs/${id}/inputs`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) });
}

export function resolveFlag(id: string, body: { option: string; note?: string }): Promise<{ remainingOpen: number }> {
  return fetchJson(`/api/flags/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// ---- Copilot, memory, goldens -----------------------------------------------

export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  actions: CopilotAction[];
  status: "ok" | "failed";
  createdAt: string;
}

export async function getCopilotThread(blueprintId: string): Promise<{ messages: CopilotMessage[] }> {
  return fetchJson(`/api/blueprints/${blueprintId}/copilot`);
}
export async function getMemories(blueprintId: string): Promise<{ memories: MemoryRow[] }> {
  return fetchJson(`/api/blueprints/${blueprintId}/memories`);
}
export async function patchMemory(id: string, status: "active" | "disabled"): Promise<void> {
  await fetchJson(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify({ status }), headers: JSON_HEADERS });
}
export async function deleteMemory(id: string): Promise<void> {
  await fetchJson(`/api/memories/${id}`, { method: "DELETE" });
}
export async function getGoldens(blueprintId: string): Promise<{ goldens: GoldenRow[] }> {
  return fetchJson(`/api/blueprints/${blueprintId}/goldens`);
}
export async function starGolden(blueprintId: string, body: { kind: "run" | "section"; runId: string; sectionKey?: string }): Promise<{ id: string }> {
  return fetchJson(`/api/blueprints/${blueprintId}/goldens`, { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS });
}
export async function deleteGolden(id: string): Promise<void> {
  await fetchJson(`/api/goldens/${id}`, { method: "DELETE" });
}
export async function uploadGolden(blueprintId: string, file: File, note?: string): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", file);
  if (note) form.append("note", note);
  return fetchJson(`/api/blueprints/${blueprintId}/goldens`, { method: "POST", body: form });
}
