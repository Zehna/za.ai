import type { FastifyInstance } from "fastify";
import type { ConversationService } from "../../core/conversation.js";

export function registerConversationRoutes(
  app: FastifyInstance,
  service: ConversationService,
): void {
  app.get("/api/conversations", async () => ({
    conversations: service.list(),
  }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = service.get(request.params.id);
    return reply.send(conversation);
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (_request, reply) => {
    service.delete(_request.params.id);
    return reply.status(204).send();
  });
}
