import { delimiter } from "node:path";
import type {
  MaterializedBundle,
  RoleBundleData,
  RuntimeSpawnOptions,
} from "@clobber/runtime";
import type { Agent, BootContext, BriefingPacket, EffortLevel, Role, Workspace } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import { composeOfficeContext } from "./office-context.ts";
import { runBootContextProvider } from "./boot-context-provider.ts";
import { OFFICE_NOTES_SKILL } from "./office-notes-skill.ts";
import { deskDirFor, writeBriefingPacket } from "./desk-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import { resolveSpawnCwd } from "./spawn-worktree.ts";
import type { SpawnPipelineDeps } from "./spawn-pipeline.ts";

export type SpawnMode = "attach" | "resume";

export interface PrepareSpawnContextInput {
  readonly mode: SpawnMode;
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly sessionId: string;
  readonly versionId: string | undefined;
  // Absent on a bare resume — no task turn to compose.
  readonly prompt: string | undefined;
  readonly briefing?: BriefingPacket;
  // Per-spawn override of the role's default effort. When supplied, beats
  // role.effort. When omitted, role.effort applies (or claude's default if
  // neither is set).
  readonly effortOverride?: EffortLevel;
}

export interface SpawnContext {
  readonly token: string;
  readonly officeDir: string | null;
  readonly materialized: MaterializedBundle;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnOptions: RuntimeSpawnOptions;
}

export interface PrepareSpawnContextNoBundleError {
  readonly ok: false;
  readonly status: 422;
  readonly error: "role has no current version";
  readonly role: string;
}

export type PrepareSpawnContextResult =
  | { readonly ok: true; readonly context: SpawnContext }
  | PrepareSpawnContextNoBundleError;

export async function prepareSpawnContext(
  deps: SpawnPipelineDeps,
  input: PrepareSpawnContextInput,
): Promise<PrepareSpawnContextResult> {
  const {
    mode,
    workspace,
    role,
    agent,
    sessionId,
    versionId,
    prompt,
    briefing,
    effortOverride,
  } = input;

  const bundle = versionId === undefined ? null : deps.roleVersions.loadAsBundle(versionId);
  if (bundle === null) {
    return {
      ok: false,
      status: 422,
      error: "role has no current version",
      role: role.name,
    };
  }

  const token = generateTokenValue();
  const officeDir = role.persistent ? ensureOffice(workspace.repo_path, agent.id) : null;

  const deskDir = mode === "attach" ? deskDirFor(workspace.repo_path, agent.id) : null;
  if (deskDir !== null && briefing !== undefined && briefing.files.length > 0) {
    writeBriefingPacket(deskDir, briefing.files);
  }

  const effectiveBundle: RoleBundleData = officeDir === null
    ? bundle
    : injectOfficeNotesSkill(bundle);

  // Boot-context provider runs for every spawn (not gated to persistent like
  // office-context); the provider script branches on role_name itself if it
  // wants audience-specific behaviour. noop returns "" → nothing injected.
  const bootContext: BootContext = {
    workspace_id: workspace.id,
    agent_id: agent.id,
    role_id: role.id,
    role_name: role.name,
    persistent: role.persistent,
  };
  const workspaceContext = await runBootContextProvider(
    workspace.boot_context_provider,
    bootContext,
  );

  // Order: durable workspace framing first, instance-specific office
  // continuity next, the task prompt last.
  const segments: string[] = [];
  if (workspaceContext !== "") {
    segments.push(`[Workspace context]\n${workspaceContext}\n[End of workspace context]`);
  }
  if (officeDir !== null) {
    segments.push(composeOfficeContext(officeDir));
  }
  if (prompt !== undefined) {
    segments.push(prompt);
  }
  // Nothing to inject (bare resume, no boot/office context) => no user turn.
  const effectivePrompt = segments.length === 0 ? undefined : segments.join("\n\n");

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
    ...(deskDir === null ? {} : { CLOBBER_DESK_DIR: deskDir }),
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
  };

  const effectiveEffort = effortOverride ?? role.effort;
  // A worktree is agent-scoped: created on the agent's first attach, reused
  // thereafter. The agent having any session on record (this attach's row is
  // written later, in attachSessionToAgent) means this is not its first.
  const agentHasSession = deps.sessions
    .listForWorkspace(workspace.id)
    .some((s) => s.agent_id === agent.id);
  const cwd = resolveSpawnCwd(workspace, agent, mode, agentHasSession);
  const spawnOptions: RuntimeSpawnOptions = {
    hookUrl: deps.hookUrl,
    prompt: effectivePrompt,
    cwd,
    sessionId,
    ...(role.permission_mode === undefined ? {} : { permissionMode: role.permission_mode }),
    ...(role.allowed_tools === undefined ? {} : { allowedTools: role.allowed_tools }),
    ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
    env,
    materialized,
    systemPrompt: effectiveBundle.systemPrompt,
    settingSources: workspace.setting_sources,
    ...(agent.label === undefined ? {} : { displayName: agent.label }),
  };

  return { ok: true, context: { token, officeDir, materialized, env, spawnOptions } };
}

function injectOfficeNotesSkill(bundle: RoleBundleData): RoleBundleData {
  const already = bundle.skills.some((s) => s.name === OFFICE_NOTES_SKILL.name);
  if (already) return bundle;
  return { ...bundle, skills: [...bundle.skills, OFFICE_NOTES_SKILL] };
}
