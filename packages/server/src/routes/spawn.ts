import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadRoleBundle, materializeBundle } from "@clobber/runtime";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { SessionTokenStore } from "../session-token-store.ts";
import { generateTokenValue } from "../session-token-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../types.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { endSession } from "../session-lifecycle.ts";

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

    const ceilingRow = deps.workspaceRoles.getCeiling(workspace_id, role_id);
    const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
    const active = deps.sessions.countActive(workspace_id, role_id);
    if (active >= ceiling) {
      reply.code(403);
      return { error: "role at capacity", ceiling, active };
    }

    const sessionId = randomUUID();
    const token = generateTokenValue();

    const bundle = loadRoleBundle(role.name);
    const bundleExtras: Pick<AgentSpawnRequest, "env" | "pluginDirs"> =
      bundle === null
        ? {}
        : (() => {
            const materialized = materializeBundle({
              bundle,
              repoPath: workspace.repo_path,
              hookUrl: deps.hookUrl,
              cliEntry: deps.cliEntry,
            });
            const baseEnv = process.env;
            const existingPath = baseEnv["PATH"] ?? "";
            const env: NodeJS.ProcessEnv = {
              ...baseEnv,
              PATH: `${materialized.binDir}${delimiter}${existingPath}`,
              CLOBBER_API_BASE: deps.apiBase,
              CLOBBER_SESSION_TOKEN: token,
              CLOBBER_SESSION_ID: sessionId,
              CLOBBER_WORKSPACE_ID: workspace.id,
              CLOBBER_ROLE: role.name,
            };
            return { env, pluginDirs: [materialized.pluginDir] };
          })();

    const agent = deps.agents.create({
      workspace_id,
      role_id,
      ...(label === undefined ? {} : { label }),
    });

    const spawnReq: AgentSpawnRequest = {
      hookUrl: deps.hookUrl,
      prompt,
      cwd: workspace.repo_path,
      sessionId,
      ...(role.permission_mode === undefined
        ? {}
        : { permissionMode: role.permission_mode }),
      ...(role.allowed_tools === undefined
        ? {}
        : { allowedTools: role.allowed_tools }),
      ...bundleExtras,
    };
    const spawned = deps.spawner(spawnReq);

    deps.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id,
      role_id,
      pid: spawned.pid,
    });
    deps.sessionTokens.register(sessionId, token);
    deps.registry.register(sessionId, spawned.stdin);

    spawned.exited.then(() => {
      deps.registry.unregister(sessionId);
      endSession(sessionId, deps);
    });

    return {
      agent_id: agent.id,
      session_id: sessionId,
      pid: spawned.pid,
    };
  });
}
