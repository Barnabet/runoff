// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// `vi.mock` factories are hoisted above the file, so the fns they close over
// must be created via `vi.hoisted` to exist before the factories run.
const { refresh, showToast, uploadSource, deleteSource } = vi.hoisted(() => ({
  refresh: vi.fn(),
  showToast: vi.fn(),
  uploadSource: vi.fn(async () => ({ id: "src_new" })),
  deleteSource: vi.fn(async () => ({ ok: true })),
}));

// App-router hooks/components need context jsdom lacks; stub them so the view
// renders standalone. The router exposes refresh() (used after upload/delete).
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

// Spy on toasts and the upload/delete API so the flows are observable.
vi.mock("@/components/Toast", () => ({ showToast, Toast: () => null }));
vi.mock("@/lib/api", () => ({ uploadSource, deleteSource }));

import { SourcesView } from "../components/sources/SourcesView";
import type { SourceRow } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Timestamps relative to now so freshness derivation is deterministic.
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const rows: SourceRow[] = [
  {
    id: "src_fresh",
    name: "spend_june.csv",
    kind: "file",
    storedFilename: "src_fresh_spend_june.csv",
    mime: "text/csv",
    size: 2048,
    uploadedAt: iso(90 * DAY),
    refreshedAt: iso(2 * MIN),
    usedBy: 3,
  },
  {
    id: "src_stale",
    name: "brand_guidelines.pdf",
    kind: "file",
    storedFilename: "src_stale_brand_guidelines.pdf",
    mime: "application/pdf",
    size: 5120,
    uploadedAt: iso(31 * DAY),
    refreshedAt: null,
    usedBy: 1,
  },
];

describe("SourcesView ledger", () => {
  it("shows the connected + stale heading count", () => {
    const { getByText } = render(<SourcesView sources={rows} />);
    expect(getByText("2 CONNECTED · 1 STALE")).toBeTruthy();
  });

  it("washes the stale row amber and marks it STALE, fresh row shows ✓ AGO", () => {
    const { getByTestId, getByText } = render(<SourcesView sources={rows} />);
    expect(getByTestId("source-row-src_stale").className).toContain("bg-amber-accent/10");
    expect(getByTestId("source-row-src_fresh").className).not.toContain("bg-amber-accent/10");
    expect(getByText(/— STALE/)).toBeTruthy();
    expect(getByText("✓ 2M AGO")).toBeTruthy();
  });

  it("optimistically swaps Request update → REMINDER SENT ✓ and toasts", () => {
    const { getByText, queryByText } = render(<SourcesView sources={rows} />);
    fireEvent.click(getByText("Request update"));
    expect(queryByText("Request update")).toBeNull();
    expect(getByText("REMINDER SENT ✓")).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith("Reminder sent.");
  });

  it("pluralises USED BY", () => {
    const { getByText } = render(<SourcesView sources={rows} />);
    expect(getByText("3 BLUEPRINTS")).toBeTruthy();
    expect(getByText("1 BLUEPRINT")).toBeTruthy();
  });
});

describe("AddSourceModal", () => {
  it("opens from the Add source pill", () => {
    const { getByText, queryByText } = render(<SourcesView sources={rows} />);
    expect(queryByText("Add a source")).toBeNull();
    fireEvent.click(getByText("Add source"));
    expect(getByText("Add a source")).toBeTruthy();
  });

  it("toasts Coming soon for a disabled kind and does not reveal the file field", () => {
    const { getByText, queryByLabelText } = render(<SourcesView sources={rows} />);
    fireEvent.click(getByText("Add source"));
    fireEvent.click(getByText("Database"));
    expect(showToast).toHaveBeenCalledWith("Coming soon");
    expect(queryByLabelText("Choose a file")).toBeNull();
  });

  it("uploads the chosen file with its defaulted name and refreshes", async () => {
    const { getByText, getByLabelText } = render(<SourcesView sources={rows} />);
    fireEvent.click(getByText("Add source"));
    fireEvent.click(getByText("Upload a file"));

    const file = new File(["a,b\n1,2\n"], "spend.csv", { type: "text/csv" });
    fireEvent.change(getByLabelText("Choose a file"), { target: { files: [file] } });
    // Name defaults to the file name.
    expect((getByLabelText("Source name") as HTMLInputElement).value).toBe("spend.csv");

    fireEvent.click(getByText("Test & continue →"));
    await waitFor(() => expect(uploadSource).toHaveBeenCalledWith(file, "spend.csv"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith("Source connected");
  });

  it("keeps Test & continue disabled until a file is chosen", () => {
    const { getByText } = render(<SourcesView sources={rows} />);
    fireEvent.click(getByText("Add source"));
    fireEvent.click(getByText("Upload a file"));
    expect((getByText("Test & continue →") as HTMLButtonElement).disabled).toBe(true);
  });
});
