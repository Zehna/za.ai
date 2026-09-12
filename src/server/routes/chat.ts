import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConversationService } from "../../core/conversation.js";
import { ValidationError } from "../errors.js";

export function makeChatRequestSchema(maxMessageChars: number) {
  return z.object({
    /** Existing conversation to continue; omitted starts a new one. */
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(maxMessageChars),
  });
}

export function parseChatRequest(
  body: unknown,
  maxMessageChars: number,
): z.infer<ReturnType<typeof makeChatRequestSchema>> {
  const result = makeChatRequestSchema(maxMessageChars).safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ValidationError(issues);
  }
  return result.data;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerChatRoutes(
  app: FastifyInstance,
  service: ConversationService,
  options: { maxMessageChars: number },
): void {
  /** Send a message and wait for the full reply. */
  app.post("/api/chat", async (request, reply) => {
    const body = parseChatRequest(request.body, options.maxMessageChars);
    const conversation = body.conversationId
      ? service.get(body.conversationId)
      : service.create(titleFrom(body.message));
    const { reply: assistantMessage } = await service.turn(conversation.id, body.message);
    return reply.status(201).send({
      conversationId: conversation.id,
      reply: assistantMessage,
    });
  });

  /** Send a message and receive the reply as server-sent events. */
  app.post("/api/chat/stream", async (request, reply) => {
    const body = parseChatRequest(request.body, options.maxMessageChars);
    const conversation = body.conversationId
      ? service.get(body.conversationId)
      : service.create(titleFrom(body.message));
    const conversationId = conversation.id;

    // Abort the upstream request when the client disconnects mid-stream.
    const clientGone = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        clientGone.abort();
      }
    });

    const turns = service.streamTurn(conversationId, body.message, clientGone.signal);

    const events = Readable.from(
      (async function* generateSse() {
        yield sseEvent("meta", { conversationId });
        try {
          for await (const delta of turns) {
            if (clientGone.signal.aborted) return;
            yield sseEvent("delta", { text: delta });
          }
          yield sseEvent("done", { conversationId });
        } catch (error) {
          yield sseEvent("error", {
            message: error instanceof Error ? error.message : "stream failed",
          });
        }
      })(),
    );

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    reply.header("x-accel-buffering", "no");
    return reply.send(events);
  });
}

function titleFrom(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}…`;
}
