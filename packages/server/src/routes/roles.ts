import type { FastifyInstance } from "fastify";
import { CreateRoleRequestSchema } from "@clobber/shared";
import type { RoleStore } from "../role-store.ts";

interface IdParam {
  id: string;
}

export function registerRoleRoutes(
  app: FastifyInstance,
  deps: { roles: RoleStore },
): void {
  const { roles } = deps;

  app.post("/roles", async (request, reply) => {
    const parsed = CreateRoleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid role request", issues: parsed.error.issues };
    }
    if (roles.findByName(parsed.data.name) !== null) {
      reply.code(409);
      return { error: "role name already exists" };
    }
    const created = roles.create(parsed.data);
    reply.code(201);
    return created;
  });

  app.get("/roles", async () => roles.list());

  app.get<{ Params: IdParam }>("/roles/:id", async (request, reply) => {
    const found = roles.get(request.params.id);
    if (found === null) {
      reply.code(404);
      return { error: "role not found" };
    }
    return found;
  });

  app.delete<{ Params: IdParam }>("/roles/:id", async (request, reply) => {
    const removed = roles.delete(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "role not found" };
    }
    reply.code(204);
    return null;
  });
}
