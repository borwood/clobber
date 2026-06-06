import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeProvider } from "@clobber/runtime";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { AgentSpawner } from "../types.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import type { NotificationStore } from "../notification-store.ts";
import { EffortLevelSchema, ModelSchema } from "@clobber/shared";
import { executeSpawn } from "../spawn-pipeline.ts";
import { normalizeSpawnLabel } from "./_spawn-label.ts";

const SpawnBodySchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  // The caller's optional opening kick. Required only for `custom` when a kick
  // is desired; absent = no kick (idle / boot-and-wait). Named / default programs
  // supply their own kick from the wake-program definition.
  prompt: z.string().min(1).optional(),
  label: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  model: ModelSchema.optional(),
  // The selected opening move (#212). "default" resolves to the role's declared
  // default_wake_program. "custom" uses the caller's prompt + system_addon (#501).
  wake_program: z.string().min(1).optional(),
  // Caller-supplied layer-C addon for the `custom` built-in (#501). Ignored for
  // all other wake-program selections.
  system_addon: z.string().optional(),
});

export interface SpawnRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  // #349 — git-as-truth read path, spread from the server boot config. Present
  // when configured; embodiment of a commit-pinned role reads through the cache.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly scheduler: Pick<TriggerScheduler, "reloadAgent">;
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
  readonly notifications: NotificationStore;
}

export function registerSpawnRoutes(app: FastifyInstance, deps: SpawnRouteDeps): void {
  app.post("/spawn", async (request, reply) => {
    const parsed = SpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { workspace_id, role_id, prompt, effort, model, wake_program, system_addon } = parsed.data;
    const label = normalizeSpawnLabel(parsed.data.label);
    if (label === null) {
      reply.code(400);
      return { error: "label is required" };
    }

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

    const result = await executeSpawn(deps, {
      workspace,
      role,
      ...(prompt === undefined ? {} : { prompt }),
      label,
      ...(wake_program === undefined ? {} : { wakeProgram: wake_program }),
      ...(system_addon === undefined ? {} : { systemAddon: system_addon }),
      ...(effort === undefined ? {} : { effortOverride: effort }),
      ...(model === undefined ? {} : { modelOverride: model }),
    });
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      reply.code(status);
      return rest;
    }
    if (role.persistent) {
      deps.scheduler.reloadAgent(result.agent_id);
    }
    return {
      agent_id: result.agent_id,
      session_id: result.session_id,
      pid: result.pid,
    };
  });
}
