import { and, eq, gt } from "drizzle-orm";
import { runEvents } from "@runoff/core";
import { getDb } from "../../../../../lib/db";

// GET /api/runs/:id/events — Server-Sent Events. Replays the existing event log,
// then polls every 200ms for newer rows; emits a heartbeat comment periodically
// and closes after a terminal event or when the client aborts.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      let last = 0;
      let alive = true;
      req.signal.addEventListener("abort", () => {
        alive = false;
      });
      const send = (row: { seq: number; payload: string }) => {
        last = row.seq;
        c.enqueue(enc.encode(`data: ${row.payload}\n\n`));
      };
      const fetchNew = () =>
        db.orm
          .select()
          .from(runEvents)
          .where(and(eq(runEvents.runId, id), gt(runEvents.seq, last)))
          .orderBy(runEvents.seq)
          .all();
      let beat = 0;
      while (alive) {
        const rows = fetchNew();
        for (const r of rows) send(r);
        if (rows.some((r) => r.type === "run_completed" || r.type === "run_failed")) break;
        if (++beat % 75 === 0) c.enqueue(enc.encode(": ping\n\n"));
        await new Promise((r) => setTimeout(r, 200));
      }
      c.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
