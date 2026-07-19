// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SourceManager, enumeratePeriods } from "../components/projects/SourceManager";
import type { FamilySummary } from "@/lib/api";
import type { ClassifyProposal, ProjectSourceRow } from "@runoff/core";

/** Route table keyed by URL substring, first match wins (specific routes first). */
function mockFetch(routes: Record<string, (init?: RequestInit, url?: string) => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (String(url).includes(prefix)) return handler(init, String(url));
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
  const filedPeriods = over.filedPeriods ?? [];
  return {
    id: over.id,
    key: over.key,
    label: over.label ?? over.key,
    kind: over.kind ?? "periodic",
    granularity: over.granularity ?? "quarter",
    filedPeriods,
    // Derive filedEntries from filedPeriods unless supplied, so periodic cells
    // carry a per-period sourceId + name for refile/delete.
    filedEntries:
      over.filedEntries ?? filedPeriods.map((p, i) => ({ period: p, sourceId: `${over.id}_s${i}`, name: `${p}.csv` })),
    liveFile: over.liveFile ?? null,
    tables: over.tables ?? [],
  };
}

/** A plan-bearing ClassifyProposal fixture (plan + preview + report). */
function planProposal(over: Partial<ClassifyProposal> = {}): ClassifyProposal {
  return {
    familyKey: "trade_data",
    period: "2026-Q2",
    confidence: "high",
    planStatus: "proposed",
    plan: {
      version: 1,
      tables: [
        {
          name: "aging",
          anchor: { headerSignature: ["customer", "amount"], minMatch: 1 },
          headerRows: 1,
          exclude: [{ column: null, pattern: "^total" }],
          columns: [
            { from: "customer", name: "customer", type: "TEXT" },
            { from: "amount", name: "amount", type: "REAL", parse: "currency" },
          ],
          onPeriodMismatch: "keep",
        },
      ],
    },
    preview: {
      tables: [{ name: "aging", columns: ["customer", "amount"], rows: [["Acme", 100], ["Beta", 200]] }],
    },
    report: {
      tables: [
        {
          name: "aging",
          anchor: { sheet: "s", row: 0 },
          problems: [],
          rowsKept: 6,
          rowsExcluded: [{ pattern: "^total", count: 1, samples: ["Total row"] }],
          coercionFailures: [],
          periodMismatches: null,
          unknownColumns: [],
        },
      ],
    },
    ...over,
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

  it("shows the mono classifying… note while a classify request is in flight, then clears it", async () => {
    let resolveClassify!: (r: Response) => void;
    const pending = new Promise<Response>((res) => { resolveClassify = res; });
    mockFetch({
      "/sources/classify": () => pending,
      "/sources": () => Response.json({ families: [], unfiled: [row({ id: "src_c", proposal: null })] }),
    });

    render(<SourceManager projectId="prj_1" families={[]} unfiled={[row({ id: "src_c", proposal: null })]} />);
    expect(screen.queryByText(/classifying/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "reclassify" }));
    expect(await screen.findByText(/classifying…/i)).toBeTruthy();

    resolveClassify(Response.json({ sources: [{ id: "src_c", proposal: null }] }));
    await waitFor(() => expect(screen.queryByText(/classifying/i)).toBeNull());
  });

  it("reclassify POSTs the source id to /sources/classify", async () => {
    let classifyBody: Record<string, unknown> | null = null;
    mockFetch({
      "/sources/classify": (init) => {
        classifyBody = JSON.parse(String(init!.body));
        return Response.json({ sources: [{ id: "src_r", proposal: null }] });
      },
      "/sources": () => Response.json({ families: [], unfiled: [row({ id: "src_r", proposal: null })] }),
    });

    render(<SourceManager projectId="prj_1" families={[]} unfiled={[row({ id: "src_r", proposal: null })]} />);
    fireEvent.click(screen.getByRole("button", { name: "reclassify" }));
    await waitFor(() => expect(classifyBody).toEqual({ sourceIds: ["src_r"] }));
  });

  it("a confirm that 400s shows the inline chip error and keeps the tray", async () => {
    mockFetch({
      "/sources/confirm": () => Response.json({ error: "family key already exists: trade_data" }, { status: 400 }),
      "/sources/classify": () => Response.json({ sources: [] }),
      "/sources": () => Response.json({ families: [], unfiled: [row({ id: "src_1", proposal: null })] }),
    });
    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];
    const unfiled = [
      row({ id: "src_1", name: "june.csv", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "high" } }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/family key already exists/i)).toBeTruthy();
    // The tray is intact — the failed confirm didn't remove the chip.
    expect(screen.getByText("june.csv")).toBeTruthy();
  });

  it("Confirm all with one failing + one succeeding still refetches and reports the failure", async () => {
    let confirmCalls = 0;
    let refetched = 0;
    mockFetch({
      "/sources/confirm": (init) => {
        confirmCalls += 1;
        const body = JSON.parse(String(init!.body)) as { period: string };
        return body.period === "2026-Q2"
          ? Response.json({ error: "slot taken" }, { status: 400 })
          : Response.json({ ok: true });
      },
      "/sources/classify": () => Response.json({ sources: [] }),
      "/sources": () => { refetched += 1; return Response.json({ families: [], unfiled: [] }); },
    });
    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];
    const unfiled = [
      row({ id: "src_a", proposal: { familyKey: "trade_data", period: "2026-Q1", confidence: "high" } }),
      row({ id: "src_b", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "medium" } }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(confirmCalls).toBe(2));
    // The successful row's refetch still ran despite the sibling failure.
    await waitFor(() => expect(refetched).toBeGreaterThanOrEqual(1));
    expect(await screen.findByText(/1 of 2 confirms failed/i)).toBeTruthy();
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

  it("warns 'replaces <occupant filename>' before confirming into an occupied slot", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const families = [
      fam({
        id: "fam_o",
        key: "trade_data",
        label: "Trade data",
        filedPeriods: ["2026-Q2"],
        filedEntries: [{ period: "2026-Q2", sourceId: "src_old", name: "old-q2.csv" }],
      }),
    ];
    const unfiled = [
      row({ id: "src_o", proposal: { familyKey: "trade_data", period: "2026-Q2", confidence: "high" } }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);
    expect(screen.getByText("replaces old-q2.csv")).toBeTruthy();
  });

  it("a periodic filed cell's delete DELETEs the entry's sourceId", async () => {
    const deletes: string[] = [];
    mockFetch({
      "/sources": (init, url) => {
        if (init?.method === "DELETE") deletes.push(String(url).split("/sources/")[1]);
        return Response.json(init?.method === "DELETE" ? { ok: true } : { families: [], unfiled: [] });
      },
    });
    const families = [
      fam({
        id: "fam_d",
        key: "trade_data",
        label: "Trade data",
        filedPeriods: ["2026-Q1"],
        filedEntries: [{ period: "2026-Q1", sourceId: "src_del", name: "q1.csv" }],
      }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={[]} />);
    fireEvent.click(screen.getByTestId("delete-src_del"));
    await waitFor(() => expect(deletes).toEqual(["src_del"]));
  });

  it("renders detected tables, skipped fragments, and drift lines on a chip", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const unfiled = [
      row({
        id: "src_t",
        name: "spend.csv",
        proposal: {
          familyKey: "spend",
          period: "2026-Q1",
          confidence: "high",
          tables: [
            { name: "fam_spend", columns: ["campaign", "amount"], rowCount: 48112 },
            { name: "fam_spend__by_region", columns: ["region", "amount"], rowCount: 12 },
          ],
          skippedFragments: 2,
          drift: ["new column: fam_spend.refund_flag (REAL)"],
        },
      }),
    ];
    render(<SourceManager projectId="prj_1" families={[]} unfiled={unfiled} />);

    expect(screen.getByText("fam_spend — 2 cols · 48,112 rows")).toBeTruthy();
    expect(screen.getByText("fam_spend__by_region — 2 cols · 12 rows")).toBeTruthy();
    expect(screen.getByText("skipped: 2 text fragment(s)")).toBeTruthy();
    expect(screen.getByText("new column: fam_spend.refund_flag (REAL)")).toBeTruthy();
  });

  it("renders the skipped line on a chip even when no tables were detected", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const unfiled = [
      row({
        id: "src_skip",
        name: "notes.csv",
        proposal: {
          familyKey: "spend",
          period: "2026-Q1",
          confidence: "high",
          tables: [],
          skippedFragments: 2,
          drift: [],
        },
      }),
    ];
    render(<SourceManager projectId="prj_1" families={[]} unfiled={unfiled} />);

    expect(screen.getByText("skipped: 2 text fragment(s)")).toBeTruthy();
    // No table line renders when tables is empty.
    expect(screen.queryByText(/cols ·/)).toBeNull();
  });

  it("renders per-table row counts on a family card and omits the block for document families", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const families = [
      fam({ id: "fam_s", key: "spend", label: "Spend", filedPeriods: ["2026-Q1"], tables: [{ name: "fam_spend", rowCount: 96224 }] }),
      fam({ id: "fam_doc", key: "policy", label: "Policy", kind: "constant", tables: [] }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={[]} />);

    expect(screen.getByText("fam_spend — 96,224 rows")).toBeTruthy();
    expect(screen.queryByText(/rows$/)).toBeTruthy();
    // The document (tables: []) family renders no per-table row-count line.
    expect(screen.queryAllByText(/— .* rows$/)).toHaveLength(1);
  });

  it("a periodic filed cell's refile opens a prefilled picker and PATCHes the new period", async () => {
    let patchUrl = "";
    let patchBody: Record<string, unknown> | null = null;
    mockFetch({
      "/sources": (init, url) => {
        if (init?.method === "PATCH") { patchUrl = String(url); patchBody = JSON.parse(String(init.body)); return Response.json({ ok: true }); }
        return Response.json({ families: [], unfiled: [] });
      },
    });
    const families = [
      fam({
        id: "fam_r",
        key: "trade_data",
        label: "Trade data",
        filedPeriods: ["2026-Q1"],
        filedEntries: [{ period: "2026-Q1", sourceId: "src_ref", name: "q1.csv" }],
      }),
    ];
    render(<SourceManager projectId="prj_1" families={families} unfiled={[]} />);
    fireEvent.click(screen.getByTestId("refile-src_ref"));
    // Prefilled with the entry's current period.
    expect((screen.getByTestId("refile-period-src_ref") as HTMLInputElement).value).toBe("2026-Q1");
    fireEvent.change(screen.getByTestId("refile-period-src_ref"), { target: { value: "2026-Q3" } });
    fireEvent.click(screen.getByTestId("refile-save-src_ref"));
    await waitFor(() => expect(patchBody).toEqual({ familyId: "fam_r", period: "2026-Q3" }));
    expect(patchUrl).toContain("/sources/src_ref");
  });

  it("renders the parsing panel: plan steps, kept/excluded counts, struck excluded sample, preview cells", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];
    const unfiled = [row({ id: "src_p", name: "aging.csv", proposal: planProposal() })];
    render(<SourceManager projectId="prj_1" families={families} unfiled={unfiled} />);

    expect(screen.getByTestId("parsing-src_p")).toBeTruthy();
    // A pinned plan-step line.
    expect(screen.getByText("customer → customer (TEXT)")).toBeTruthy();
    // Per-table counts.
    expect(screen.getByText("aging — kept 6 · excluded 1")).toBeTruthy();
    // Struck-through excluded sample.
    const sample = screen.getByText("Total row");
    expect(sample.className).toContain("line-through");
    // Preview cell text.
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("labels a stored plan and renders report problem lines in amber", () => {
    mockFetch({ "/sources": () => Response.json({ families: [], unfiled: [] }) });
    const proposal = planProposal({
      planStatus: "stored",
      report: {
        tables: [
          {
            name: "aging",
            anchor: null,
            problems: ["unanchored table: aging"],
            rowsKept: 0,
            rowsExcluded: [],
            coercionFailures: [],
            periodMismatches: null,
            unknownColumns: [],
          },
        ],
      },
    });
    const unfiled = [row({ id: "src_s", name: "aging.csv", proposal })];
    render(<SourceManager projectId="prj_1" families={[]} unfiled={unfiled} />);

    expect(screen.getByText("parsing — stored plan")).toBeTruthy();
    const problem = screen.getByText("unanchored table: aging");
    expect(problem.className).toContain("text-amber");
  });

  it("typing feedback and clicking 'revise plan' POSTs the replan and swaps in the returned proposal", async () => {
    let replanBody: Record<string, unknown> | null = null;
    const revised = planProposal({
      planStatus: "amended",
      preview: { tables: [{ name: "aging", columns: ["customer", "amount"], rows: [["Gamma", 300]] }] },
    });
    mockFetch({
      "/replan": (init) => {
        replanBody = JSON.parse(String(init!.body));
        return Response.json({ proposal: revised });
      },
      "/sources": () => Response.json({ families: [], unfiled: [] }),
    });
    const unfiled = [row({ id: "src_f", name: "aging.csv", proposal: planProposal() })];
    render(<SourceManager projectId="prj_1" families={[]} unfiled={unfiled} />);

    fireEvent.change(screen.getByPlaceholderText("what did the parse get wrong?"), { target: { value: "wrong anchor" } });
    fireEvent.click(screen.getByRole("button", { name: "revise plan" }));

    await waitFor(() => expect(replanBody).toEqual({ feedback: "wrong anchor" }));
    // The returned proposal is swapped in (new preview cell), old one gone.
    expect(await screen.findByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("the mismatch checkbox appears only when periodMismatches.count > 0 and flips the confirm body", async () => {
    let confirmBody: Record<string, unknown> | null = null;
    mockFetch({
      "/sources/confirm": (init) => { confirmBody = JSON.parse(String(init!.body)); return Response.json({ ok: true }); },
      "/sources": () => Response.json({ families: [], unfiled: [] }),
    });
    const families = [fam({ id: "fam_trade", key: "trade_data", label: "Trade data" })];

    // No mismatches: checkbox absent.
    const { unmount } = render(
      <SourceManager projectId="prj_1" families={families} unfiled={[row({ id: "src_ok", proposal: planProposal() })]} />,
    );
    expect(screen.queryByText("exclude period-mismatched rows")).toBeNull();
    unmount();

    // With mismatches + a period check: checkbox appears and drives the confirm body.
    const withMismatch = planProposal({
      plan: {
        version: 1,
        tables: [
          {
            name: "aging",
            anchor: { headerSignature: ["customer", "amount"], minMatch: 1 },
            headerRows: 1,
            exclude: [],
            columns: [
              { from: "customer", name: "customer", type: "TEXT" },
              { from: "as of", name: "as_of", type: "TEXT", parse: "date" },
            ],
            periodColumn: "as_of",
            onPeriodMismatch: "keep",
          },
        ],
      },
      report: {
        tables: [
          {
            name: "aging",
            anchor: { sheet: "s", row: 0 },
            problems: [],
            rowsKept: 6,
            rowsExcluded: [],
            coercionFailures: [],
            periodMismatches: { count: 3, samples: ["2025-Q4"] },
            unknownColumns: [],
          },
        ],
      },
    });
    render(<SourceManager projectId="prj_1" families={families} unfiled={[row({ id: "src_m", proposal: withMismatch })]} />);

    const checkbox = screen.getByText("exclude period-mismatched rows").querySelector("input") as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(confirmBody).toEqual({ sourceId: "src_m", familyId: "fam_trade", period: "2026-Q2", periodMismatch: "exclude" }),
    );
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
