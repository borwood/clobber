import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import { materializeBundle } from "@clobber/runtime";
import type { Agent, Role, Workspace } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
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
  readonly roleVersions: RoleVersionStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly prompt: string;
  readonly label: string;
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

export interface SpawnPipelineNoBundleError {
  readonly ok: false;
  readonly status: 422;
  readonly error: "role has no current version";
  readonly role: string;
}

export type SpawnPipelineResult =
  | SpawnPipelineSuccess
  | SpawnPipelineCapacityError
  | SpawnPipelineNoBundleError;

export function executeSpawn(
  deps: SpawnPipelineDeps,
  input: SpawnPipelineInput,
): SpawnPipelineResult {
  const { workspace, role, prompt, label } = input;

  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;

  const agent = deps.agents.create({
    workspace_id: workspace.id,
    role_id: role.id,
    label,
  });
  return attachSessionToAgent(deps, { workspace, role, agent, prompt });
}

export interface AttachSessionInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
}

export function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): SpawnPipelineSuccess | SpawnPipelineNoBundleError {
  const { workspace, role, agent, prompt } = input;

  const versionId = role.current_version_id;
  const bundle = versionId === undefined ? null : deps.roleVersions.loadAsBundle(versionId);
  if (bundle === null) {
    return {
      ok: false,
      status: 422,
      error: "role has no current version",
      role: role.name,
    };
  }

  const sessionId = randomUUID();
  const token = generateTokenValue();

  const materialized = materializeBundle({
    bundle,
    repoPath: workspace.repo_path,
    hookUrl: deps.hookUrl,
    cliEntry: deps.cliEntry,
  });

  const officeDir = role.persistent
    ? ensureOffice(workspace.repo_path, agent.id)
    : null;

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
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
  };
  const bundleExtras: Pick<
    AgentSpawnRequest,
    "env" | "pluginDirs" | "appendSystemPrompt"
  > = {
    env,
    pluginDirs: [materialized.pluginDir],
    appendSystemPrompt: bundle.systemPrompt,
  };

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
    role_version_id: versionId,
    pid: spawned.pid,
  });
  deps.sessionTokens.register(sessionId, token);
  deps.registry.register(sessionId, spawned.stdin, spawned.kill);

  spawned.exited.then(() => {
    deps.registry.unregister(sessionId);
    endSession(sessionId, deps);
  });

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}

function checkCapacity(
  deps: SpawnPipelineDeps,
  workspace: Workspace,
  role: Role,
): SpawnPipelineCapacityError | null {
  const ceilingRow = deps.workspaceRoles.getCeiling(workspace.id, role.id);
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const active = deps.sessions.countActive(workspace.id, role.id);
  if (active >= ceiling) {
    return { ok: false, status: 403, error: "role at capacity", ceiling, active };
  }
  return null;
}
