import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { CreateWorkspaceRequestSchema } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import { seedWorkspaceRoles } from "../seed-workspace-roles.ts";
import { validateWorkspacePath } from "../validate-workspace-path.ts";

interface IdParam {
  id: string;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    workspaces: WorkspaceStore;
  },
): void {
  const { db, workspaces } = deps;

  app.post("/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid workspace request", issues: parsed.error.issues };
    }
    const validation = validateWorkspacePath(parsed.data.repo_path);
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    if (workspaces.findByName(parsed.data.name) !== null) {
      reply.code(409);
      return { error: "workspace name already exists" };
    }
    const created = workspaces.create(parsed.data);
    seedWorkspaceRoles(db, created.id);
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
