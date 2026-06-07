import { delimiter } from "node:path";
import type {
  MaterializedBundle,
  RoleBundleData,
  RuntimeSpawnOptions,
} from "@clobber/runtime";
import type { Agent, BootContext, BriefingPacket, CliScope, ClobberPromptTag, EffortLevel, Model, Role, Workspace } from "@clobber/shared";
import { allCapabilityNames, CALLER_SUPPLIED_KICK, CALLER_SUPPLIED_SYSTEM, isActionAllowed, resolveWakeProgram } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import { composeOfficeContext } from "./office-context.ts";
import { composeUnackedNotifications } from "./notification-inbox.ts";
import { composeSystemPrompt } from "./compose-system-prompt.ts";
import { resolvePromptModuleCatalog } from "./workspace-prompt-module-catalog.ts";
import { composePromptModules } from "./compose-prompt-modules.ts";
import { OFFICE_NOTES_SKILL } from "./office-notes-skill.ts";
import { deskDirFor, writeBriefingPacket } from "./desk-store.ts";
import { generateTokenValue } from "./session-token-store.ts";
import { resolveCurrentRoleVersion } from "./resolve-role-content.ts";
import { resolveSpawnCwd } from "./spawn-worktree.ts";
import { embodyRole, type RolePin } from "./embody-role.ts";
import type { SpawnPipelineDeps } from "./spawn-pipeline.ts";

export type SpawnMode = "attach" | "resume";

export interface PrepareSpawnContextInput {
  readonly mode: SpawnMode;
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly sessionId: string;
  // The role/session pin to embody (#349) — a role_versions row or a commit ref.
  // Null when the role has no current version (→ the no-bundle refusal below).
  readonly pin: RolePin | null;
  // Absent on a bare resume — no task turn to compose.
  readonly prompt: string | undefined;
  // Provenance for the prompt the caller passed. When a wake-program supplies
  // the opening kick, this is overridden to `wake-kick` (the kick content is
  // the program's, not the caller's). Bare (undefined) is reserved for the
  // human composer path — never produced on a spawn path.
  readonly promptTag?: ClobberPromptTag;
  // The selected opening move. Resolved against the role's wake-programs with
  // `idle` as the built-in; undefined selects `idle`. On a fresh attach a named
  // program supplies layer C + the opening kick; on resume only layer C is
  // re-composed (the kick is suppressed). The full selection surfaces — spawn
  // arg / trigger map / office UI — are #213; this is the minimal by-name seam.
  readonly wakeProgram?: string;
  // Caller-supplied layer-C addon for the `custom` built-in (#501). When the
  // selected program declares CALLER_SUPPLIED_SYSTEM, this string is used as the
  // wake-program's system contribution (empty string if omitted).
  readonly systemAddon?: string;
  // Op-level system addon injected by the triggering operation (#502). Absent
  // for plain spawn; the cycle operation supplies the orientation text. When
  // present this is persisted on the session row so resume re-composes it.
  readonly opLevelAddon?: string;
  readonly briefing?: BriefingPacket;
  // Per-spawn override of the role's default effort. When supplied, beats
  // role.effort. When omitted, role.effort applies (or claude's default if
  // neither is set).
  readonly effortOverride?: EffortLevel;
  // Per-spawn override of the role's default model. Same precedence as effort:
  // override > role.model > unset (no `--model` arg → claude's own default).
  readonly modelOverride?: Model;
}

export interface SpawnContext {
  readonly token: string;
  readonly scope_json: string;
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
    pin,
    prompt,
    promptTag,
    wakeProgram,
    systemAddon,
    opLevelAddon,
    briefing,
    effortOverride,
    modelOverride,
  } = input;

  const bundle = embodyRole(role, pin, deps);
  if (bundle === null) {
    return {
      ok: false,
      status: 422,
      error: "role has no current version",
      role: role.name,
    };
  }

  const token = generateTokenValue();

  // Bake ws∩role at spawn time; stored with the token so authorizeCommand can serve
  // it without re-resolving role+workspace on every command. NULL-scope tokens (tokens
  // that pre-date this column) fall back to the live 2-tier path (#567).
  const version = resolveCurrentRoleVersion(role, deps);
  // version cannot be null here: embodyRole above already resolved the same source.
  const roleAllowList = JSON.parse(version!.allowed_cli_commands_json) as readonly string[];
  const roleScope: CliScope = { allow: roleAllowList as string[], deny: [] };
  const agentScope: CliScope = { allow: ["*"], deny: [] }; // no per-agent override in PR1
  const bakedAllow = allCapabilityNames().filter(
    (v) => isActionAllowed(workspace.perms_scope, v) && isActionAllowed(roleScope, v) && isActionAllowed(agentScope, v),
  );
  const scope_json = JSON.stringify({ allow: bakedAllow, deny: [] });

  const officeDir = role.persistent ? ensureOffice(workspace.repo_path, agent.id) : null;

  const deskDir = mode === "attach" ? deskDirFor(workspace.repo_path, agent.id) : null;
  if (deskDir !== null && briefing !== undefined && briefing.files.length > 0) {
    writeBriefingPacket(deskDir, briefing.files);
  }

  const effectiveBundle: RoleBundleData = officeDir === null
    ? bundle
    : injectOfficeNotesSkill(bundle);

  // Layer B — the role's prompt-modules (#211). The role declares an ordered,
  // toggleable list of refs; each resolves against the workspace catalog (shipped
  // defaults overlaid by <repo>/.clobber/prompt-modules/) and composes its static
  // text or its dynamic provider's stdout. Dynamic modules get the spawn env below
  // so a script can read its actual office/desk paths instead of reconstructing them.
  const bootContext: BootContext = {
    workspace_id: workspace.id,
    agent_id: agent.id,
    role_id: role.id,
    role_name: role.name,
    persistent: role.persistent,
  };
  const seedEnv: Record<string, string> = {
    CLOBBER_ROLE: role.name,
    CLOBBER_AGENT_ID: agent.id,
    CLOBBER_REPO_PATH: workspace.repo_path,
    ...(officeDir === null ? {} : { CLOBBER_OFFICE_DIR: officeDir }),
    ...(deskDir === null ? {} : { CLOBBER_DESK_DIR: deskDir }),
  };
  const seeds = await composePromptModules(
    effectiveBundle.promptModuleRefs,
    resolvePromptModuleCatalog(workspace.repo_path, deps.apiBase),
    bootContext,
    seedEnv,
  );

  // Instance-specific office continuity rides after the seeds — it is this
  // agent's office state, not a shareable seed. The opening user message
  // carries only the task kick (absent on a no-task wake).
  if (officeDir !== null) {
    seeds.push(composeOfficeContext(officeDir));
    // Phase-2 (#526): non-flushing boot re-dump — unacknowledged notifications
    // surface on every persistent-agent wake WITHOUT clearing them.
    seeds.push(composeUnackedNotifications(agent.id, deps.notifications));
  }

  // Layer C — the selected wake-program's system addon. Composed on every
  // embodiment, including resume. The opening user-message kick the program
  // owns fires only on a fresh attach; on resume it is suppressed (the session
  // already carries its history) so the turn is just the resume prompt. When no
  // program is selected the caller's prompt remains the opening message — the
  // legacy seam until #213 routes selection through every spawn surface.
  const program = resolveWakeProgram(effectiveBundle.wakePrograms, wakeProgram);
  // A selected program declaring a caller-supplied kick contributes only its
  // layer-C `system`; its opening turn falls through to the caller's prompt, the
  // way `idle` does — the third kick mode the `custom` built-in (#501) uses.
  const callerSuppliedKick = program.user === CALLER_SUPPLIED_KICK;
  const wakeProgramSuppliesKick =
    mode !== "resume" && wakeProgram !== undefined && !callerSuppliedKick;
  const kick = wakeProgramSuppliesKick
    ? program.user === null
      ? undefined
      : program.user
    : prompt;
  // When a wake-program supplied a fixed kick, its content is the program's —
  // not the caller's — so the tag is `wake-kick` regardless of what the caller
  // passed. Otherwise the caller's tag rides through (a caller-supplied kick
  // carries its own provenance; for cycle the orchestration tags it `wake-kick`).
  // A resume reuses the caller's tag too (the resume prompt's provenance —
  // ask-answer / live-inject — is what the agent sees).
  const kickTag: ClobberPromptTag | undefined =
    kick === undefined
      ? undefined
      : wakeProgramSuppliesKick
        ? { kind: "wake-kick" }
        : promptTag;

  const wakeProgramAddon = program.system === CALLER_SUPPLIED_SYSTEM
    ? (systemAddon ?? "")
    : program.system;

  const systemPrompt = composeSystemPrompt({
    framing: effectiveBundle.framing,
    rolePrompt: effectiveBundle.systemPrompt,
    seeds,
    opLevelAddon: opLevelAddon ?? "",
    wakeProgramAddon,
  });

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
  const effectiveModel = modelOverride ?? role.model;
  // A worktree is agent-scoped: created on the agent's first attach, reused
  // thereafter. The agent having any session on record (this attach's row is
  // written later, in attachSessionToAgent) means this is not its first.
  const agentHasSession = deps.sessions
    .listForWorkspace(workspace.id)
    .some((s) => s.agent_id === agent.id);
  const cwd = resolveSpawnCwd(workspace, agent, mode, agentHasSession);
  const spawnOptions: RuntimeSpawnOptions = {
    hookUrl: deps.hookUrl,
    prompt: kick,
    ...(kickTag === undefined ? {} : { promptTag: kickTag }),
    cwd,
    sessionId,
    ...(role.permission_mode === undefined ? {} : { permissionMode: role.permission_mode }),
    ...(effectiveBundle.allowedTools.length === 0
      ? {}
      : { allowedTools: effectiveBundle.allowedTools }),
    ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
    ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
    env,
    materialized,
    systemPrompt,
    settingSources: workspace.setting_sources,
    ...(agent.label === undefined ? {} : { displayName: agent.label }),
  };

  return { ok: true, context: { token, scope_json, officeDir, materialized, env, spawnOptions } };
}

function injectOfficeNotesSkill(bundle: RoleBundleData): RoleBundleData {
  const already = bundle.skills.some((s) => s.name === OFFICE_NOTES_SKILL.name);
  if (already) return bundle;
  return { ...bundle, skills: [...bundle.skills, OFFICE_NOTES_SKILL] };
}
