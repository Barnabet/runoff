import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
// Import the internal entry point to avoid pdf-parse's index.js debug self-test.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export interface ParsedTable {
  name: string;
  columns: string[];
  rows: Record<string, string | number>[];
}

export interface PackedSource {
  id: string;
  label: string;
  kind: "table" | "document" | "pdf";
  tables?: ParsedTable[]; // csv → 1 table; xlsx → 1 per worksheet
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

/** Columns whose totals are worth surfacing in a table summary. */
const NUMERIC_SUMMARY_COLUMNS = ["amount", "spend", "revenue", "sessions", "value", "total"];

const DEFAULT_MAX_ROWS = 40;
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

export async function buildSourcePack(files: EngineFile[]): Promise<SourcePack> {
  const sources = await Promise.all(files.map(buildSource));
  return { sources };
}

function buildSource(file: EngineFile): Promise<PackedSource> {
  switch (classify(file)) {
    case "csv":
      return buildCsv(file);
    case "xlsx":
      return buildXlsx(file);
    case "pdf":
      return buildPdf(file);
    case "docx":
    default:
      // Unknown types fall back to plain-text extraction rather than crashing a run.
      return buildDocument(file);
  }
}

async function buildCsv(file: EngineFile): Promise<PackedSource> {
  const content = await readFile(file.path, "utf8");
  const parsed = Papa.parse<Record<string, string | number>>(content, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  const rows = parsed.data;
  const columns = parsed.meta.fields ?? (rows[0] ? Object.keys(rows[0]) : []);
  const table: ParsedTable = { name: file.name, columns, rows };
  return {
    id: file.id,
    label: file.name,
    kind: "table",
    tables: [table],
    summary: tableSummary(table),
  };
}

async function buildXlsx(file: EngineFile): Promise<PackedSource> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);
  const tables: ParsedTable[] = [];

  workbook.eachSheet((sheet) => {
    // Capture each header's true column index so blank spacer columns (a gap in
    // the header row) don't shift the data of every subsequent column.
    const headers: { name: string; colNumber: number }[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers.push({ name: cellText(cell.value), colNumber });
    });
    const columns = headers.map((h) => h.name);

    const rows: Record<string, string | number>[] = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      if (!row.hasValues) continue;
      const record: Record<string, string | number> = {};
      for (const { name, colNumber } of headers) {
        record[name] = cellValue(row.getCell(colNumber).value);
      }
      rows.push(record);
    }

    tables.push({ name: sheet.name, columns, rows });
  });

  return {
    id: file.id,
    label: file.name,
    kind: "table",
    tables,
    summary: tables.map(tableSummary).join("; "),
  };
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

function tableSummary(table: ParsedTable): string {
  const cols = table.columns.map((col) => {
    if (!NUMERIC_SUMMARY_COLUMNS.includes(col.toLowerCase())) return col;
    let total = 0;
    let hasNumber = false;
    for (const row of table.rows) {
      const v = row[col];
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        hasNumber = true;
      }
    }
    return hasNumber ? `${col} (sum ${total.toLocaleString("en-US")})` : col;
  });
  return `${table.name} — ${table.rows.length} rows · columns: ${cols.join(", ")}`;
}

/** Serialize selected sources for a drafting prompt. */
export function packForPrompt(
  pack: SourcePack,
  sourceIds: string[],
  maxRowsPerTable: number = DEFAULT_MAX_ROWS,
): string {
  const chosen = pack.sources.filter((s) => sourceIds.includes(s.id));
  return chosen.map((s) => serializeSource(s, maxRowsPerTable)).join("\n\n");
}

function serializeSource(source: PackedSource, maxRows: number): string {
  const parts: string[] = [`### ${source.label} (${source.id})`, source.summary];

  if (source.kind === "table" && source.tables) {
    for (const table of source.tables) {
      parts.push(serializeTable(table, source.tables.length > 1, maxRows));
    }
  } else if ((source.kind === "document" || source.kind === "pdf") && source.text) {
    // PDFs are text-extracted locally, so they serialize like documents.
    parts.push(source.text.slice(0, MAX_DOCUMENT_CHARS));
  }

  return parts.join("\n");
}

function serializeTable(table: ParsedTable, includeName: boolean, maxRows: number): string {
  const lines: string[] = [];
  if (includeName) lines.push(`# ${table.name}`);
  lines.push(table.columns.map(csvCell).join(","));
  for (const row of table.rows.slice(0, maxRows)) {
    lines.push(table.columns.map((col) => csvCell(row[col])).join(","));
  }
  if (table.rows.length > maxRows) {
    lines.push(`… ${table.rows.length - maxRows} more rows`);
  }
  return lines.join("\n");
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// --- exceljs cell coercion -------------------------------------------------

function cellText(value: unknown): string {
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

function cellValue(value: unknown): string | number {
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
