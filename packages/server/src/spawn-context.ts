import { delimiter } from "node:path";
import type {
  MaterializedBundle,
  RoleBundleData,
  RuntimeSpawnOptions,
} from "@clobber/runtime";
import type { Agent, BriefingPacket, EffortLevel, Role, Workspace } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import { composeOfficeContext } from "./office-context.ts";
import { OFFICE_NOTES_SKILL } from "./office-notes-skill.ts";
import { deskDirFor, writeBriefingPacket } from "./desk-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import type { SpawnPipelineDeps } from "./spawn-pipeline.ts";

export type SpawnMode = "attach" | "resume";

export interface PrepareSpawnContextInput {
  readonly mode: SpawnMode;
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly sessionId: string;
  readonly versionId: string | undefined;
  readonly prompt: string;
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

export function prepareSpawnContext(
  deps: SpawnPipelineDeps,
  input: PrepareSpawnContextInput,
): PrepareSpawnContextResult {
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
    ...(deskDir === null ? {} : { CLOBBER_DESK_DIR: deskDir }),
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
  };

  const effectiveEffort = effortOverride ?? role.effort;
  const spawnOptions: RuntimeSpawnOptions = {
    hookUrl: deps.hookUrl,
    prompt: effectivePrompt,
    cwd: workspace.repo_path,
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
