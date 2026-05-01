import type { FastifyInstance } from "fastify";
import { CreateWorkspaceRequestSchema } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";

interface IdParam {
  id: string;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { workspaces: WorkspaceStore },
): void {
  const { workspaces } = deps;

  app.post("/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid workspace request", issues: parsed.error.issues };
    }
    if (workspaces.findByName(parsed.data.name) !== null) {
      reply.code(409);
      return { error: "workspace name already exists" };
    }
    const created = workspaces.create(parsed.data);
    reply.code(201);
    return created;
  });

  app.get("/workspaces", async () => workspaces.list());

  app.get<{ Params: IdParam }>("/workspaces/:id", async (request, reply) => {
    const found = workspaces.get(request.params.id);
    if (found === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    return found;
  });

  app.delete<{ Params: IdParam }>("/workspaces/:id", async (request, reply) => {
    const removed = workspaces.delete(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    reply.code(204);
    return null;
  });
}
