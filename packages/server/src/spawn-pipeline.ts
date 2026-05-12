import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import type { RoleBundleData, RuntimeEvent, RuntimeProvider } from "@clobber/runtime";
import type { Agent, BriefingPacket, Role, Workspace } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import { composeOfficeContext } from "./office-context.ts";
import { OFFICE_NOTES_SKILL } from "./office-notes-skill.ts";
import { deskDirFor, writeBriefingPacket } from "./desk-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import { endSession } from "./session-lifecycle.ts";

export interface SpawnPipelineDeps {
  readonly workspaces: WorkspaceStore;
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
  readonly runtimeProvider: RuntimeProvider;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
}

export interface SpawnPipelineInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly prompt: string;
  readonly label: string;
  readonly briefing?: BriefingPacket;
}

export interface SpawnPipelineSuccess {
  readonly ok: true;
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

export interface ResumeTurnSuccess {
  readonly ok: true;
  readonly session_id: string;
  readonly pid: number;
}

export interface ResumeTurnError {
  readonly ok: false;
  readonly status: 409 | 410 | 422 | 502;
  readonly error:
    | "runtime does not support resume"
    | "runtime provider thread unavailable"
    | "runtime provider thread not found"
    | "workspace not found"
    | "role not found"
    | "agent not found"
    | "role has no current version"
    | "runtime resume failed";
  readonly detail?: string;
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
  const { workspace, role, prompt, label, briefing } = input;

  const capacity = checkCapacity(deps, workspace, role);
  if (capacity !== null) return capacity;

  const agent = deps.agents.create({
    workspace_id: workspace.id,
    role_id: role.id,
    label,
  });
  return attachSessionToAgent(deps, {
    workspace,
    role,
    agent,
    prompt,
    ...(briefing === undefined ? {} : { briefing }),
  });
}

export interface AttachSessionInput {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
  readonly briefing?: BriefingPacket;
}

export function attachSessionToAgent(
  deps: SpawnPipelineDeps,
  input: AttachSessionInput,
): SpawnPipelineSuccess | SpawnPipelineNoBundleError {
  const { workspace, role, agent, prompt, briefing } = input;

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

  const officeDir = role.persistent
    ? ensureOffice(workspace.repo_path, agent.id)
    : null;

  const deskDir = deskDirFor(workspace.repo_path, agent.id);
  if (briefing !== undefined && briefing.files.length > 0) {
    writeBriefingPacket(deskDir, briefing.files);
  }

  const effectiveBundle: RoleBundleData = officeDir === null
    ? bundle
    : injectOfficeNotesSkill(bundle);
  const effectivePrompt = officeDir === null
    ? prompt
    : `${composeOfficeContext(officeDir)}\n\n${prompt}`;

  const materialized = deps.runtimeProvider.prepareBundle({
    bundle: effectiveBundle,
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
    CLOBBER_DESK_DIR: deskDir,
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
  };
  const spawnReq = deps.runtimeProvider.buildSpawnRequest({
    hookUrl: deps.hookUrl,
    prompt: effectivePrompt,
    cwd: workspace.repo_path,
    sessionId,
    ...(role.permission_mode === undefined
      ? {}
      : { permissionMode: role.permission_mode }),
    ...(role.allowed_tools === undefined
      ? {}
      : { allowedTools: role.allowed_tools }),
    env,
    materialized,
    systemPrompt: effectiveBundle.systemPrompt,
    ...(agent.label === undefined ? {} : { displayName: agent.label }),
  });
  const spawned = deps.spawner(spawnReq);
  const providerThreadId = deps.runtimeProvider.initialProviderThreadId(sessionId);

  deps.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: workspace.id,
    role_id: role.id,
    role_version_id: versionId,
    runtime_provider: deps.runtimeProvider.id,
    ...(providerThreadId === undefined ? {} : { provider_thread_id: providerThreadId }),
    // Denormalize the agent's label onto the session so the sidebar can
    // still show it after the agent row is deleted on non-persistent end.
    ...(agent.label === undefined ? {} : { label: agent.label }),
    pid: spawned.pid,
    transcript_path: deps.runtimeProvider.transcriptPath(workspace.repo_path, sessionId),
  });
  deps.sessionTokens.register(sessionId, token);
  deps.registry.register(sessionId, spawned.stdin, spawned.kill);
  bindRuntimeEvents(deps, sessionId, spawned);

  spawned.exited.then((code) => {
    deps.registry.unregister(sessionId);
    if (deps.runtimeProvider.capabilities.processLifetime === "session") {
      endSession(sessionId, deps);
      return;
    }
    if (code !== 0 && code !== null) {
      endSession(sessionId, deps);
    }
  });

  return { ok: true, agent_id: agent.id, session_id: sessionId, pid: spawned.pid };
}

export async function resumeSessionTurn(
  deps: SpawnPipelineDeps,
  input: { readonly sessionId: string; readonly prompt: string },
): Promise<ResumeTurnSuccess | ResumeTurnError> {
  const session = deps.sessions.get(input.sessionId);
  if (session === null || session.ended_at !== undefined) {
    return { ok: false, status: 409, error: "runtime provider thread unavailable" };
  }
  if (!deps.runtimeProvider.capabilities.resume || deps.runtimeProvider.buildResumeRequest === undefined) {
    return { ok: false, status: 409, error: "runtime does not support resume" };
  }
  const providerThreadId = session.provider_thread_id;
  if (providerThreadId === undefined) {
    return { ok: false, status: 409, error: "runtime provider thread unavailable" };
  }
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return { ok: false, status: 422, error: "workspace not found" };
  const role = deps.roles.get(session.role_id);
  if (role === null) return { ok: false, status: 422, error: "role not found" };
  const agent = session.agent_id === undefined ? null : deps.agents.get(session.agent_id);
  if (agent === null) return { ok: false, status: 422, error: "agent not found" };
  const versionId = session.role_version_id ?? role.current_version_id;
  const bundle = versionId === undefined ? null : deps.roleVersions.loadAsBundle(versionId);
  if (bundle === null) {
    return { ok: false, status: 422, error: "role has no current version" };
  }

  const token = generateTokenValue();
  const officeDir = role.persistent
    ? ensureOffice(workspace.repo_path, agent.id)
    : null;
  const effectiveBundle: RoleBundleData = officeDir === null
    ? bundle
    : injectOfficeNotesSkill(bundle);
  const effectivePrompt = officeDir === null
    ? input.prompt
    : `${composeOfficeContext(officeDir)}\n\n${input.prompt}`;
  const materialized = deps.runtimeProvider.prepareBundle({
    bundle: effectiveBundle,
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
    CLOBBER_SESSION_ID: session.id,
    CLOBBER_WORKSPACE_ID: workspace.id,
    CLOBBER_ROLE: role.name,
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
  };

  const spawnReq = deps.runtimeProvider.buildResumeRequest({
    hookUrl: deps.hookUrl,
    prompt: effectivePrompt,
    cwd: workspace.repo_path,
    sessionId: session.id,
    providerThreadId,
    ...(role.permission_mode === undefined
      ? {}
      : { permissionMode: role.permission_mode }),
    ...(role.allowed_tools === undefined
      ? {}
      : { allowedTools: role.allowed_tools }),
    env,
    materialized,
    systemPrompt: effectiveBundle.systemPrompt,
    ...(agent.label === undefined ? {} : { displayName: agent.label }),
  });

  let spawned: SpawnedAgentInfo;
  try {
    spawned = deps.spawner(spawnReq);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isProviderThreadMissing(detail)) {
      endSession(session.id, deps);
      return {
        ok: false,
        status: 410,
        error: "runtime provider thread not found",
        detail,
      };
    }
    return {
      ok: false,
      status: 502,
      error: "runtime resume failed",
      detail,
    };
  }

  const startup = await waitForRuntimeStartup(spawned);
  if (!startup.ok) {
    if (isProviderThreadMissing(startup.detail)) {
      endSession(session.id, deps);
      return {
        ok: false,
        status: 410,
        error: "runtime provider thread not found",
        detail: startup.detail,
      };
    }
    return {
      ok: false,
      status: 502,
      error: "runtime resume failed",
      detail: startup.detail,
    };
  }

  deps.sessionTokens.register(session.id, token);
  deps.sessions.updatePid(session.id, spawned.pid);
  deps.registry.register(session.id, spawned.stdin, spawned.kill);
  bindRuntimeEvents(deps, session.id, spawned);
  spawned.exited.then((code) => {
    deps.registry.unregister(session.id);
    if (code !== 0 && code !== null) {
      endSession(session.id, deps);
    }
  });
  return { ok: true, session_id: session.id, pid: spawned.pid };
}

async function waitForRuntimeStartup(
  spawned: SpawnedAgentInfo,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  if (spawned.startup === undefined) return { ok: true };
  return spawned.startup;
}

function bindRuntimeEvents(
  deps: Pick<SpawnPipelineDeps, "sessions">,
  sessionId: string,
  spawned: SpawnedAgentInfo,
): void {
  if (spawned.runtimeEvents === undefined) return;
  void consumeRuntimeEvents(deps, sessionId, spawned.runtimeEvents);
}

async function consumeRuntimeEvents(
  deps: Pick<SpawnPipelineDeps, "sessions">,
  sessionId: string,
  events: AsyncIterable<RuntimeEvent>,
): Promise<void> {
  for await (const event of events) {
    if (event.kind === "provider-thread-started") {
      deps.sessions.updateProviderThreadId(sessionId, event.providerThreadId);
    }
  }
}

function isProviderThreadMissing(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("provider thread not found") ||
    normalized.includes("thread not found") ||
    normalized.includes("session not found") ||
    normalized.includes("no rollout found") ||
    normalized.includes("no such session")
  );
}

function injectOfficeNotesSkill(bundle: RoleBundleData): RoleBundleData {
  const already = bundle.skills.some((s) => s.name === OFFICE_NOTES_SKILL.name);
  if (already) return bundle;
  return { ...bundle, skills: [...bundle.skills, OFFICE_NOTES_SKILL] };
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
