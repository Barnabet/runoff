// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// App-router hooks/components need context that jsdom lacks; stub them so the
// view renders standalone. Links become plain anchors (href still assertable).
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import { LibraryView } from "../components/library/LibraryView";
import type { BlueprintListItem } from "../lib/api";

afterEach(cleanup);

const rows: BlueprintListItem[] = [
  {
    id: "bp_flagged",
    name: "Monthly Performance Report",
    clientName: "Meridian Retail",
    cadenceLabel: "Monthly",
    status: "active",
    currentRev: 3,
    sourceCount: 5,
    lastRun: { id: "run_38", finishedAt: "2026-07-01 09:14:00", status: "complete", openFlags: 2 },
  },
  {
    id: "bp_clean",
    name: "Weekly Trading Summary",
    clientName: "Internal — Finance",
    cadenceLabel: "Weekly",
    status: "active",
    currentRev: 7,
    sourceCount: 3,
    lastRun: { id: "run_40", finishedAt: "2026-07-14 08:00:00", status: "complete", openFlags: 0 },
  },
  {
    id: "bp_draft",
    name: "Proposal — Harbor Logistics",
    clientName: "New business",
    cadenceLabel: "Monthly",
    status: "draft",
    currentRev: 1,
    sourceCount: 1,
    lastRun: null,
  },
];

describe("LibraryView", () => {
  it("shows a review card only for the blueprint with open flags", () => {
    const { getAllByText, getByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    const reviewLinks = getAllByText("Review");
    expect(reviewLinks).toHaveLength(1);
    expect(reviewLinks[0].getAttribute("href")).toBe("/runs/run_38");
    // The card names its client and flag count.
    expect(getByText(/Meridian Retail — run finished with 2 flags/)).toBeTruthy();
  });

  it("renders a DRAFT badge for draft rows only", () => {
    const { getAllByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    expect(getAllByText("DRAFT")).toHaveLength(1);
  });

  it("renders the LAST RUN status: red flags for open, muted clean, dash for none", () => {
    const { getByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    const flags = getByText("2 FLAGS");
    expect(flags.className).toContain("text-pencil");
    expect(getByText("✓ CLEAN")).toBeTruthy();
  });

  it("shows the heading count of active + await-review blueprints", () => {
    const { getByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    expect(getByText("2 ACTIVE · 1 AWAIT REVIEW")).toBeTruthy();
  });

  it("filters the ledger to drafts when the Drafts pill is clicked", () => {
    const { getByRole, getByText, queryByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    // All three rows present initially.
    expect(getByText("Monthly Performance Report")).toBeTruthy();
    expect(getByText("Weekly Trading Summary")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Drafts" }));

    expect(queryByText("Monthly Performance Report")).toBeNull();
    expect(queryByText("Weekly Trading Summary")).toBeNull();
    expect(getByText("Proposal — Harbor Logistics")).toBeTruthy();
  });

  it("filters the ledger by search text across name and client", () => {
    const { getByLabelText, getByText, queryByText } = render(<LibraryView blueprints={rows} projectId="proj_x" />);
    fireEvent.change(getByLabelText("Search blueprints"), { target: { value: "harbor" } });
    expect(getByText("Proposal — Harbor Logistics")).toBeTruthy();
    expect(queryByText("Monthly Performance Report")).toBeNull();
  });
});
