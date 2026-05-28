import { delimiter } from "node:path";
import type {
  MaterializedBundle,
  RoleBundleData,
  RuntimeSpawnOptions,
} from "@clobber/runtime";
import type { Agent, BootContext, BriefingPacket, ClobberPromptTag, EffortLevel, Role, Workspace } from "@clobber/shared";
import { resolveWakeProgram } from "@clobber/shared";
import { ensureOffice } from "./office-store.ts";
import { composeOfficeContext } from "./office-context.ts";
import { composeSystemPrompt } from "./compose-system-prompt.ts";
import { resolveSeedCatalog } from "./workspace-seed-catalog.ts";
import { composeSeeds } from "./compose-seeds.ts";
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
    promptTag,
    wakeProgram,
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

  // Layer B — the role's seeds (#211). The role declares an ordered, toggleable
  // list of refs; each resolves against the workspace catalog (shipped defaults
  // overlaid by <repo>/.clobber/seeds/) and composes its static text or its
  // dynamic provider's stdout. Dynamic seeds get the spawn env below so a script
  // can read its actual office/desk paths instead of reconstructing them.
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
  const seeds = await composeSeeds(
    effectiveBundle.seedRefs,
    resolveSeedCatalog(workspace.repo_path),
    bootContext,
    seedEnv,
  );

  // Instance-specific office continuity rides after the seeds — it is this
  // agent's office state, not a shareable seed. The opening user message
  // carries only the task kick (absent on a no-task wake).
  if (officeDir !== null) {
    seeds.push(composeOfficeContext(officeDir));
  }

  // Layer C — the selected wake-program's system addon. Composed on every
  // embodiment, including resume. The opening user-message kick the program
  // owns fires only on a fresh attach; on resume it is suppressed (the session
  // already carries its history) so the turn is just the resume prompt. When no
  // program is selected the caller's prompt remains the opening message — the
  // legacy seam until #213 routes selection through every spawn surface.
  const program = resolveWakeProgram(effectiveBundle.wakePrograms, wakeProgram);
  const wakeProgramSuppliesKick =
    mode !== "resume" && wakeProgram !== undefined;
  const kick = wakeProgramSuppliesKick
    ? program.user === null
      ? undefined
      : program.user
    : prompt;
  // When a wake-program supplied the kick, its content is the program's — not
  // the caller's — so the tag is `wake-kick` regardless of what the caller
  // passed. Otherwise the caller's tag rides through. A resume reuses the
  // caller's tag too (the resume prompt's provenance — ask-answer / live-
  // inject — is what the agent sees).
  const kickTag: ClobberPromptTag | undefined =
    kick === undefined
      ? undefined
      : wakeProgramSuppliesKick
        ? { kind: "wake-kick" }
        : promptTag;

  const systemPrompt = composeSystemPrompt({
    framing: effectiveBundle.framing,
    rolePrompt: effectiveBundle.systemPrompt,
    seeds,
    wakeProgramAddon: program.system,
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
    ...(role.allowed_tools === undefined ? {} : { allowedTools: role.allowed_tools }),
    ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
    env,
    materialized,
    systemPrompt,
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
