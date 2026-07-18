// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CopilotRail } from "../components/builder/CopilotRail";
import type { BlueprintContent } from "@runoff/core";

const DRAFT: BlueprintContent = {
  title: "R", clientName: "C", eyebrow: "E", dateline: "D",
  sections: [{ key: "exec", number: 1, heading: "Exec", mode: "auto", instruction: "old", sourceIds: [], rules: [] }],
  globalRules: [], delivery: { recipient: "a@b.c", autoDeliverOnClear: false },
};

/** Build an SSE Response streaming the given events then closing. */
function sseResponse(events: object[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const EDIT_OP = {
  type: "edit_section", key: "exec",
  before: { instruction: "old" }, after: { instruction: "new and specific" },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

function mockFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (String(url).includes(prefix)) return handler(init);
    }
    return Response.json({}, { status: 404 });
  }));
}

describe("CopilotRail", () => {
  it("renders the persisted thread", async () => {
    mockFetch({
      "/copilot": () => Response.json({ messages: [
        { id: "m1", role: "user", body: "make it tighter", actions: [], status: "ok", createdAt: "" },
        { id: "m2", role: "assistant", body: "Done.", actions: [{ kind: "edit", op: EDIT_OP }], status: "ok", createdAt: "" },
      ] }),
    });
    render(<CopilotRail blueprintId="bp_1" selectedKey="exec" selectedHeading="Exec" getDraft={() => DRAFT} onEditOp={() => {}} />);
    await waitFor(() => expect(screen.getByText("make it tighter")).toBeTruthy());
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(screen.getByText(/§1 Exec · instruction/i)).toBeTruthy(); // edit card title
  });

  it("renders copilot markdown (bold, code, lists); user bodies stay plain", async () => {
    mockFetch({
      "/copilot": () => Response.json({ messages: [
        { id: "m1", role: "user", body: "what **sources**?", actions: [], status: "ok", createdAt: "" },
        { id: "m2", role: "assistant", body: "Two sources:\n\n- **June Spend** with `amount`\n- GA4 export", actions: [], status: "ok", createdAt: "" },
      ] }),
    });
    render(<CopilotRail blueprintId="bp_1" selectedKey="exec" selectedHeading="Exec" getDraft={() => DRAFT} onEditOp={() => {}} />);
    const bold = await screen.findByText("June Spend");
    expect(bold.tagName).toBe("STRONG");
    const code = screen.getByText("amount");
    expect(code.tagName).toBe("CODE");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // The user's literal markdown is untouched — no <strong> is created from it.
    expect(screen.getByText("what **sources**?").tagName).toBe("P");
  });

  it("streams a turn: applies edit ops via onEditOp and shows the edit card with Revert", async () => {
    const onEditOp = vi.fn();
    mockFetch({
      "/copilot": (init) =>
        init?.method === "POST"
          ? sseResponse([
              { type: "tool_activity", label: "editing §exec" },
              { type: "edit", op: EDIT_OP },
              { type: "text_delta", text: "Tightened it." },
              { type: "done", messageId: "m9" },
            ])
          : Response.json({ messages: [] }),
    });
    render(<CopilotRail blueprintId="bp_1" selectedKey="exec" selectedHeading="Exec" getDraft={() => DRAFT} onEditOp={onEditOp} />);
    fireEvent.change(await screen.findByPlaceholderText(/ask the copilot/i), { target: { value: "tighten" } });
    fireEvent.submit(screen.getByTestId("copilot-composer"));
    await waitFor(() => expect(onEditOp).toHaveBeenCalledWith(EDIT_OP));
    expect(await screen.findByText("Tightened it.")).toBeTruthy();

    // Revert applies the inverse op and marks the card.
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    expect(onEditOp).toHaveBeenLastCalledWith({ ...EDIT_OP, before: EDIT_OP.after, after: EDIT_OP.before });
    expect(screen.getByText(/reverted/i)).toBeTruthy();
  });

  it("shows a retry affordance when the stream reports an error, and Retry re-sends the message", async () => {
    let posts = 0;
    mockFetch({
      "/copilot": (init) => {
        if (init?.method !== "POST") return Response.json({ messages: [] });
        posts += 1;
        return posts === 1
          ? sseResponse([{ type: "text_delta", text: "partial" }, { type: "error", message: "proxy died" }])
          : sseResponse([{ type: "text_delta", text: "recovered" }, { type: "done", messageId: "m9" }]);
      },
    });
    render(<CopilotRail blueprintId="bp_1" selectedKey={null} selectedHeading="" getDraft={() => DRAFT} onEditOp={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText(/ask the copilot/i), { target: { value: "hi" } });
    fireEvent.submit(screen.getByTestId("copilot-composer"));
    expect(await screen.findByText(/proxy died/i)).toBeTruthy();
    expect(posts).toBe(1);

    // Clicking Retry re-POSTs the failed message and streams a fresh turn.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(posts).toBe(2));
    expect(await screen.findByText("recovered")).toBeTruthy();
  });
});
