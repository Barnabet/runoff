// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SourceManager, enumeratePeriods } from "../components/projects/SourceManager";
import type { FamilySummary } from "@/lib/api";
import type { ProjectSourceRow } from "@runoff/core";

/** Route table keyed by URL substring, first match wins (specific routes first). */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (String(url).includes(prefix)) return handler(init);
    }
    return Response.json({}, { status: 404 });
  }));
}

/** Minimal ProjectSourceRow fixture. */
function row(over: Partial<ProjectSourceRow> & { id: string }): ProjectSourceRow {
  return {
    id: over.id,
    projectId: "prj_1",
    familyId: null,
    period: null,
    name: over.name ?? `${over.id}.csv`,
    kind: "table",
    storedFilename: "x",
    mime: "text/csv",
    size: 10,
    status: "unfiled",
    proposal: over.proposal ?? null,
    uploadedAt: "",
    filedAt: null,
    ...over,
  } as ProjectSourceRow;
}

function fam(over: Partial<FamilySummary> & { id: string; key: string }): FamilySummary {
  return {
    id: over.id,
    key: over.key,
    label: over.label ?? over.key,
    kind: over.kind ?? "periodic",
    granularity: over.granularity ?? "quarter",
    filedPeriods: over.filedPeriods ?? [],
    liveFile: over.liveFile ?? null,
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe("SourceManager", () => {
  it("renders an unfiled chip from a proposal and confirms into the resolved family", async () => {
    let confirmBody: Record<string, unknown> | null = null;
    mockFetch({
      "/sources/confirm": (init) => {
        confirmBody = JSON.parse(String(init!.body));
        return Response.json({ ok: true });
      },
      "/sources/classify": () => Response.json({ sources: [] }),
      "/sources": () => Response.json({ families: [], unfiled: [] }),
    });

    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];
    const unfiled = [
      row({ id: "src_1", name: "june.csv", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "high" } }),
    ];

    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);

    expect(screen.getByText("trade_data · Q2 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(confirmBody).toEqual({ sourceId: "src_1", familyId: "fam_trade", period: "2026-Q2" }));
  });

  it("renders pickers for a proposal-less row; Confirm stays disabled until family+period are chosen", async () => {
    mockFetch({
      "/sources/confirm": () => Response.json({ ok: true }),
      "/sources/classify": () => Response.json({ sources: [] }),
      "/sources": () => Response.json({ families: [], unfiled: [] }),
    });

    const families = [fam({ id: "fam_x", key: "spend", label: "Spend", kind: "periodic", granularity: "quarter" })];
    const unfiled = [row({ id: "src_2", name: "mystery.csv", proposal: null })];

    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);

    // Not classifying at rest.
    expect(screen.queryByText(/classifying/i)).toBeNull();

    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("family-src_2"), { target: { value: "fam_x" } });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("period-src_2"), { target: { value: "2026-Q1" } });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Confirm all fires one confirm POST per proposal-bearing row", async () => {
    let confirms = 0;
    mockFetch({
      "/sources/confirm": () => {
        confirms += 1;
        return Response.json({ ok: true });
      },
      "/sources/classify": () => Response.json({ sources: [] }),
      "/sources": () => Response.json({ families: [], unfiled: [] }),
    });

    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];
    const unfiled = [
      row({ id: "src_a", proposal: { familyKey: "trade_data", period: "2026-Q1", confidence: "high" } }),
      row({ id: "src_b", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "medium" } }),
    ];

    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(confirms).toBe(2));
  });

  it("renders the family tree ascending and marks in-range gaps", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const families = [
      fam({ id: "fam_g", key: "trade_data", label: "Trade data", filedPeriods: ["2026-Q1", "2026-Q3"] }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={[]} />);

    expect(screen.getByText("Q1 2026 ✓")).toBeTruthy();
    expect(screen.getByText("Q2 2026 —")).toBeTruthy(); // in-range gap
    expect(screen.getByText("Q3 2026 ✓")).toBeTruthy();
  });

  it("warns 'replaces' before confirming into an occupied slot", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const families = [fam({ id: "fam_o", key: "trade_data", label: "Trade data", filedPeriods: ["2026-Q2"] })];
    const unfiled = [
      row({ id: "src_o", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "high" } }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);
    expect(screen.getByText(/replaces/i)).toBeTruthy();
  });
});

describe("enumeratePeriods", () => {
  it("steps quarters, months, and years inclusively", () => {
    expect(enumeratePeriods("2026-Q1", "2026-Q3")).toEqual(["2026-Q1", "2026-Q2", "2026-Q3"]);
    expect(enumeratePeriods("2025-Q4", "2026-Q1")).toEqual(["2025-Q4", "2026-Q1"]);
    expect(enumeratePeriods("2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(enumeratePeriods("2024", "2026")).toEqual(["2024", "2025", "2026"]);
  });
});
