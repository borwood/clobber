import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import { loadRoleBundle, materializeBundle } from "@clobber/runtime";
import type { Role, Workspace } from "@clobber/shared";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RoleStore } from "./role-store.ts";
import { endSession } from "./session-lifecycle.ts";

export interface SpawnPipelineDeps {
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly registry: AgentRegistry;
  readonly roles: RoleStore;
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly prompt: string;
  readonly label?: string;
}

export interface SpawnPipelineSuccess {
  readonly ok: true;
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

export interface SpawnPipelineCapacityError {
  readonly ok: false;
  readonly status: 403;
  readonly error: "role at capacity";
  readonly ceiling: number;
  readonly active: number;
}

export type SpawnPipelineResult = SpawnPipelineSuccess | SpawnPipelineCapacityError;

export function executeSpawn(
  deps: SpawnPipelineDeps,
  input: SpawnPipelineInput,
): SpawnPipelineResult {
  const { workspace, role, prompt, label } = input;

  const ceilingRow = deps.workspaceRoles.getCeiling(workspace.id, role.id);
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const active = deps.sessions.countActive(workspace.id, role.id);
  if (active >= ceiling) {
    return { ok: false, status: 403, error: "role at capacity", ceiling, active };
  }

  const sessionId = randomUUID();
  const token = generateTokenValue();

  const bundle = loadRoleBundle(role.name);
  const bundleExtras: Pick<
    AgentSpawnRequest,
    "env" | "pluginDirs" | "appendSystemPrompt"
  > =
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
          return {
            env,
            pluginDirs: [materialized.pluginDir],
            appendSystemPrompt: bundle.systemPrompt,
          };
        })();

  const agent = deps.agents.create({
    workspace_id: workspace.id,
    role_id: role.id,
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
    workspace_id: workspace.id,
    role_id: role.id,
    pid: spawned.pid,
  });
  deps.sessionTokens.register(sessionId, token);
  deps.registry.register(sessionId, spawned.stdin);

  spawned.exited.then(() => {
    deps.registry.unregister(sessionId);
    endSession(sessionId, deps);
  });

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}
