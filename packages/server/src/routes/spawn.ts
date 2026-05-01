import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PermissionModeSchema } from "@clobber/shared";
import type { AgentSpawner, AgentSpawnRequest } from "../types.ts";

const SpawnBodySchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
});

export function registerSpawnRoutes(
  app: FastifyInstance,
  deps: { spawner: AgentSpawner; hookUrl: string },
): void {
  app.post("/spawn", async (request, reply) => {
    const parsed = SpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { prompt, cwd, sessionId, permissionMode, allowedTools } = parsed.data;

    const req: AgentSpawnRequest = {
      hookUrl: deps.hookUrl,
      prompt,
      cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
    };

    const result = deps.spawner(req);
    return { sessionId: result.sessionId, pid: result.pid };
  });
}
