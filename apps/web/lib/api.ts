import type { BlueprintContent, RunEvent } from "@runoff/core";
import type { ProposedEdit } from "@runoff/engine";

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
  refreshedAt: string | null;
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

export function listBlueprints(): Promise<{ blueprints: BlueprintListItem[] }> {
  return fetchJson("/api/blueprints");
}

export function createBlueprint(body: { name: string; clientName: string }): Promise<{ id: string }> {
  return fetchJson("/api/blueprints", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getBlueprint(
  id: string,
): Promise<{ blueprint: BlueprintRow; content: BlueprintContent; sources: SourceRow[] }> {
  return fetchJson(`/api/blueprints/${id}`);
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

export function refreshSource(id: string): Promise<{ ok: true; refreshedAt: string }> {
  return fetchJson(`/api/sources/${id}`, { method: "POST" });
}

// ---- Runs, flags, notes -----------------------------------------------------

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
}

export interface NoteRow {
  id: string;
  author: "user" | "agent";
  body: string;
  proposedEdit: ProposedEdit | null;
  status: string;
  createdAt: string;
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

export function getNotes(blueprintId: string, sectionKey: string): Promise<{ notes: NoteRow[] }> {
  return fetchJson(`/api/blueprints/${blueprintId}/notes?sectionKey=${encodeURIComponent(sectionKey)}`);
}

export function postNote(blueprintId: string, body: { sectionKey: string; body: string }): Promise<{ agentNote: NoteRow }> {
  return fetchJson(`/api/blueprints/${blueprintId}/notes`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function acceptNote(noteId: string): Promise<{ rev: number }> {
  return fetchJson(`/api/notes/${noteId}/accept`, { method: "POST" });
}
