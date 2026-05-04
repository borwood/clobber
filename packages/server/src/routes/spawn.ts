import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { AgentSpawner } from "../types.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import { executeSpawn } from "../spawn-pipeline.ts";

const SpawnBodySchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  prompt: z.string().min(1),
  label: z.string().min(1).optional(),
});

export interface SpawnRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly registry: AgentRegistry;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

export function registerSpawnRoutes(app: FastifyInstance, deps: SpawnRouteDeps): void {
  app.post("/spawn", async (request, reply) => {
    const parsed = SpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { workspace_id, role_id, prompt, label } = parsed.data;

    const workspace = deps.workspaces.get(workspace_id);
    if (workspace === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    const role = deps.roles.get(role_id);
    if (role === null) {
      reply.code(404);
      return { error: "role not found" };
    }

    const result = executeSpawn(deps, {
      workspace,
      role,
      prompt,
      ...(label === undefined ? {} : { label }),
    });
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      reply.code(status);
      return rest;
    }
    return {
      agent_id: result.agent_id,
      session_id: result.session_id,
      pid: result.pid,
    };
  });
}
