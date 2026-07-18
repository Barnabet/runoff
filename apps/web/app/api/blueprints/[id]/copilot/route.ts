import { BlueprintContentSchema, newId, type CopilotAction } from "@runoff/core";
import { copilotTurn, type CopilotEvent } from "@runoff/engine";
import { getDb } from "../../../../../lib/db";
import { getLlmClient } from "../../../../../lib/llm";
import { buildCopilotContext } from "../../../../../lib/queries";
import { listGoldens, resolveGoldenText } from "../../../../../lib/goldens";

type Ctx = { params: Promise<{ id: string }> };

const SELECT_MSG =
  "SELECT id, role, body, actions, status, created_at AS createdAt FROM copilot_messages";

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;
  const rows = db.sqlite.prepare(`${SELECT_MSG} WHERE blueprint_id = ? ORDER BY rowid`).all(id) as {
    id: string;
    role: string;
    body: string;
    actions: string | null;
    status: string;
    createdAt: string;
  }[];
  return Response.json({
    messages: rows.map((r) => ({ ...r, actions: r.actions ? (JSON.parse(r.actions) as CopilotAction[]) : [] })),
  });
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const db = getDb();
  const { id } = await ctx.params;

  let body: { message?: unknown; draft?: unknown; selectedKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "message is required" }, { status: 400 });
  const parsed = BlueprintContentSchema.safeParse(body.draft);
  if (!parsed.success) return Response.json({ error: "invalid draft" }, { status: 400 });
  const draft = parsed.data;
  const selectedKey = typeof body.selectedKey === "string" ? body.selectedKey : null;

  // Thread + memories load BEFORE inserting the new user row.
  const thread = (
    db.sqlite
      .prepare("SELECT role, body FROM copilot_messages WHERE blueprint_id = ? AND status = 'ok' ORDER BY rowid")
      .all(id) as { role: "user" | "assistant"; body: string }[]
  ).map((r) => ({ role: r.role, body: r.body }));
  const memories = (
    db.sqlite
      .prepare("SELECT body FROM memories WHERE blueprint_id = ? AND status = 'active' ORDER BY rowid")
      .all(id) as { body: string }[]
  ).map((r) => r.body);

  db.sqlite
    .prepare("INSERT INTO copilot_messages (id, blueprint_id, role, body) VALUES (?, ?, 'user', ?)")
    .run(newId("cmsg"), id, message);

  // Pre-resolve golden texts so the engine context stays synchronous.
  const goldenCache = new Map<string, { description: string; text: string }>();
  for (const g of listGoldens(db, id)) {
    const resolved = await resolveGoldenText(db, g.id);
    if (resolved) goldenCache.set(g.id, resolved);
  }
  const context = buildCopilotContext(db, id, goldenCache);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = (e: CopilotEvent) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      let streamedText = "";
      const streamedActions: CopilotAction[] = [];
      const io = {
        emit(e: CopilotEvent) {
          if (e.type === "text_delta") streamedText += e.text;
          if (e.type === "edit") streamedActions.push({ kind: "edit", op: e.op });
          if (e.type === "memory_saved") streamedActions.push({ kind: "memory", memoryId: e.memoryId, body: e.body });
          send(e);
        },
      };
      const msgId = newId("cmsg");
      try {
        const result = await copilotTurn({
          client: getLlmClient(),
          draft,
          selectedKey,
          message,
          thread,
          memories,
          ctx: context,
          io,
        });
        db.sqlite
          .prepare("INSERT INTO copilot_messages (id, blueprint_id, role, body, actions) VALUES (?, ?, 'assistant', ?, ?)")
          .run(msgId, id, result.reply, JSON.stringify(result.actions));
        send({ type: "done", messageId: msgId });
      } catch (err) {
        db.sqlite
          .prepare(
            "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions, status) VALUES (?, ?, 'assistant', ?, ?, 'failed')",
          )
          .run(msgId, id, streamedText, JSON.stringify(streamedActions));
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      c.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
