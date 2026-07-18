// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { RunDialog } from "../components/builder/RunDialog";

const OPTIONS = {
  granularity: "quarter" as const,
  periods: [
    {
      period: "2026-Q2",
      families: [
        { key: "trade", label: "Trade data", present: true },
        { key: "web", label: "Web traffic", present: false },
      ],
    },
    {
      period: "2026-Q1",
      families: [
        { key: "trade", label: "Trade data", present: true },
        { key: "web", label: "Web traffic", present: true },
      ],
    },
  ],
  constants: [{ key: "brand", label: "Brand kit", present: true }],
};

let lastRunBody: unknown = null;

function mockFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      for (const [prefix, handler] of Object.entries(routes)) {
        if (String(url).includes(prefix)) return handler(init);
      }
      return Response.json({}, { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  lastRunBody = null;
});
afterEach(() => cleanup());

describe("RunDialog", () => {
  it("defaults the select to the latest period and marks an absent family missing", async () => {
    mockFetch({ "/run-options": () => Response.json(OPTIONS) });
    render(<RunDialog blueprintId="bp_1" onClose={() => {}} />);

    const select = (await screen.findByLabelText("period")) as HTMLSelectElement;
    // Latest period is first in the descending list.
    expect(select.value).toBe("2026-Q2");
    // In 2026-Q2 the web family has not filed — rendered as a missing line.
    expect(screen.getByText(/Web traffic — missing/)).toBeTruthy();
    // The present family and constant render as satisfied (no "missing").
    expect(screen.getByText(/^✓ Trade data$/)).toBeTruthy();
    expect(screen.getByText(/^✓ Brand kit$/)).toBeTruthy();
  });

  it("POSTs { blueprintId, period } for the selected period and routes to the run", async () => {
    mockFetch({
      "/run-options": () => Response.json(OPTIONS),
      "/api/runs": (init) => {
        lastRunBody = JSON.parse(String(init?.body));
        return Response.json({ id: "run_z" });
      },
    });
    render(<RunDialog blueprintId="bp_1" onClose={() => {}} />);

    await screen.findByLabelText("period");
    fireEvent.click(screen.getByText("Run"));

    await waitFor(() => expect(lastRunBody).toEqual({ blueprintId: "bp_1", period: "2026-Q2" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_z"));
  });

  it("switching the period updates the checklist", async () => {
    mockFetch({ "/run-options": () => Response.json(OPTIONS) });
    render(<RunDialog blueprintId="bp_1" onClose={() => {}} />);

    const select = (await screen.findByLabelText("period")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "2026-Q1" } });
    // In 2026-Q1 both periodic families are present — no missing line.
    expect(screen.queryByText(/missing/)).toBeNull();
  });
});
