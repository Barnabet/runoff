/// <reference path="./pdf-parse.d.ts" />
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
// Import the internal entry point to avoid pdf-parse's index.js debug self-test.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export interface PackedSource {
  id: string;
  label: string;
  kind: "document" | "pdf";
  text?: string; // docx / pdf extracted text
  summary: string;
}

export interface SourcePack {
  sources: PackedSource[];
}

export interface EngineFile {
  id: string;
  name: string;
  mime: string;
  path: string;
}

const MAX_DOCUMENT_CHARS = 8_000;

type SourceKind = "csv" | "xlsx" | "docx" | "pdf" | "unknown";

/** Dispatch on mime type, falling back to file extension. */
function classify(file: EngineFile): SourceKind {
  const mime = file.mime.toLowerCase();
  if (mime.includes("csv")) return "csv";
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel")) return "xlsx";
  if (mime.includes("wordprocessingml") || mime.includes("msword")) return "docx";
  if (mime.includes("pdf")) return "pdf";

  switch (extname(file.name).toLowerCase()) {
    case ".csv":
      return "csv";
    case ".xlsx":
    case ".xls":
      return "xlsx";
    case ".docx":
    case ".doc":
      return "docx";
    case ".pdf":
      return "pdf";
    default:
      return "unknown";
  }
}

/**
 * Build the source pack from document families only — the warehouse owns every
 * tabular file, so csv/xlsx are skipped entirely and never reach the prompt.
 */
export async function buildSourcePack(files: EngineFile[]): Promise<SourcePack> {
  const sources = await Promise.all(
    files.filter((f) => !["csv", "xlsx"].includes(classify(f))).map(buildSource),
  );
  return { sources };
}

function buildSource(file: EngineFile): Promise<PackedSource> {
  switch (classify(file)) {
    case "pdf":
      return buildPdf(file);
    case "docx":
    default:
      // Unknown types fall back to plain-text extraction rather than crashing a run.
      return buildDocument(file);
  }
}

async function buildDocument(file: EngineFile): Promise<PackedSource> {
  const kind = classify(file);
  let text = "";
  if (kind === "docx") {
    const result = await mammoth.extractRawText({ path: file.path });
    text = result.value ?? "";
  } else {
    text = await readFile(file.path, "utf8");
  }
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    id: file.id,
    label: file.name,
    kind: "document",
    text,
    summary: `${file.name} — document, ${words.toLocaleString("en-US")} words`,
  };
}

async function buildPdf(file: EngineFile): Promise<PackedSource> {
  const buffer = await readFile(file.path);
  const kb = Math.max(1, Math.round(buffer.byteLength / 1024));
  // Extract text locally so the PDF's contents flow through the source pack like
  // any document. Never let a malformed PDF crash the whole pack build.
  let text = "";
  try {
    const data = await pdfParse(buffer);
    text = data.text;
  } catch {
    text = "";
  }
  return {
    id: file.id,
    label: file.name,
    kind: "pdf",
    text,
    summary: `${file.name} — PDF, ${kb} KB (read at run time)`,
  };
}

/** Raw extracted text of one file — the same reader buildSourcePack uses, without prompt packaging. */
export async function extractFileText(file: EngineFile): Promise<string> {
  const pack = await buildSourcePack([file]);
  return pack.sources.map((s) => s.text ?? "").join("\n\n");
}

/** Serialize selected sources for a drafting prompt. */
export function packForPrompt(pack: SourcePack, sourceIds: string[]): string {
  const chosen = pack.sources.filter((s) => sourceIds.includes(s.id));
  return chosen.map(serializeSource).join("\n\n");
}

function serializeSource(source: PackedSource): string {
  const parts: string[] = [`### ${source.label} (${source.id})`, source.summary];
  // PDFs are text-extracted locally, so they serialize like documents.
  if (source.text) parts.push(source.text.slice(0, MAX_DOCUMENT_CHARS));
  return parts.join("\n");
}

// --- exceljs cell coercion -------------------------------------------------
// Kept for tabular.ts, which coerces warehouse cell values through cellValue.

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((t: { text?: string }) => t.text ?? "").join("");
    if ("result" in o) return o.result == null ? "" : String(o.result);
    return String(value);
  }
  return String(value);
}

export function cellValue(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.result === "number") return o.result;
    return cellText(value);
  }
  return String(value);
}
