import { z } from "zod";
import { PermissionModeSchema } from "../hooks/payloads.ts";
import { PromptModuleRefSchema } from "./prompt-module.ts";
import { WakeProgramSchema } from "./wake-program.ts";

// Reasoning depth knob exposed by `claude --effort <level>`. Mirrors the
// upstream CLI's enum — kept in lockstep with what the runtime can pass through.
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// Model knob exposed by `claude --model <model>`. The closed set of aliases the
// CLI accepts (verified against `claude --help`: e.g. 'sonnet', 'opus'); each
// resolves to the latest model in that family. Unset → no `--model` arg → claude's
// own default (backward-compat). Lets a workspace route execution lanes to a
// cheaper model than the deep-design default. Mirrors EffortLevelSchema.
export const ModelSchema = z.enum(["opus", "sonnet", "haiku"]);
export type Model = z.infer<typeof ModelSchema>;

// A role name is a git-branch-safe slug: roles ARE branches in the upstream
// repo (#349), so every creation/fork/checkout site constrains the name to this
// shape before it reaches git. The `ROLE.md` frontmatter codec (#216) and the
// agent-roles routes share this one definition.
export const ROLE_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const RoleNameSchema = z.string().min(1).regex(ROLE_NAME_RE);

export const SdlcPhaseSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message: "must be lowercase kebab-case (a–z, 0–9, hyphen, leading letter)",
    }),
  label: z.string().min(1),
  description: z.string().min(1),
});
export type SdlcPhase = z.infer<typeof SdlcPhaseSchema>;

export const SdlcProfileSchema = z
  .object({
    phases: z.array(SdlcPhaseSchema).min(1).readonly(),
    defaultStartingPhase: z.string().min(1),
    reportCliCommand: z.string().min(1).optional(),
  })
  .refine(
    (p) =>
      new Set(p.phases.map((ph) => ph.id)).size === p.phases.length,
    { message: "phase ids must be unique", path: ["phases"] },
  )
  .refine(
    (p) => p.phases.some((ph) => ph.id === p.defaultStartingPhase),
    {
      message: "defaultStartingPhase must reference an id present in phases",
      path: ["defaultStartingPhase"],
    },
  );
export type SdlcProfile = z.infer<typeof SdlcProfileSchema>;

// #349 git-as-truth — a pin into the upstream role git repo: the fork branch
// plus the exact tip sha embodiment reads its content back from. A git-backed
// role carries `current_commit` instead of a `current_version_id` row pointer.
export const CommitRefSchema = z.object({
  branch: z.string().min(1),
  sha: z.string().min(1),
});
export type CommitRef = z.infer<typeof CommitRefSchema>;

export const RoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  effort: EffortLevelSchema.optional(),
  model: ModelSchema.optional(),
  persistent: z.boolean(),
  workspace_id: z.string().uuid().optional(),
  // A role is pinned EITHER by a `role_versions` row (current_version_id, the
  // pre-#349 store) OR by a commit into the upstream role repo (current_commit,
  // git-as-truth). Embodiment dispatches on which is present.
  current_version_id: z.string().uuid().optional(),
  current_commit: CommitRefSchema.optional(),
  created_at: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof RoleSchema>;

export const RoleSkillSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
});
export type RoleSkill = z.infer<typeof RoleSkillSchema>;

// The role-authored default wake-program for a trigger — the opening move the
// fired wake composes, mirroring how a trigger's enabled-by-default state is the
// role default for enable/disable. A workspace can override it per trigger via
// `trigger_overrides[roleId].wake_programs` (see workspace.ts). Absent both, the
// wake keeps the legacy synthesized-prompt-as-kick. Shared across kinds so any
// trigger can carry a mapping; `triggerId()` ignores it (the id stays keyed on
// the trigger's identity, so an override keyed by id survives a remap).
const wakeProgramField = { wake_program: z.string().min(1).optional() };

export const CronTriggerSchema = z.object({
  kind: z.literal("cron"),
  expr: z.string().min(1),
  ...wakeProgramField,
});
export const FileWatchTriggerSchema = z.object({
  kind: z.literal("file-watch"),
  glob: z.string().min(1),
  ...wakeProgramField,
});
export const WebhookTriggerSchema = z.object({
  kind: z.literal("webhook"),
  path: z.string().min(1).startsWith("/"),
  ...wakeProgramField,
});
export const IssueAssignedTriggerSchema = z.object({
  kind: z.literal("issue-assigned"),
  repo: z.string().min(1).optional(),
  ...wakeProgramField,
});
export const WorkspaceOpenTriggerSchema = z.object({
  kind: z.literal("workspace-open"),
  debounce_ms: z.number().int().nonnegative().optional(),
  ...wakeProgramField,
});
// Fires when any session in the workspace ends (clean exit, crash, or kill),
// sourced from the reaper's callers — the cross-agent "a worker finished" wake.
// A persistent role (the manager) declaring it gets woken with the finished
// session's outcome rebuilt from persistent state. See #171.
export const SessionEndedTriggerSchema = z.object({
  kind: z.literal("session-ended"),
  ...wakeProgramField,
});
// Fires when a worker declares itself finished via `clobber status done` —
// the worker's own terminal handoff. Unlike `session-ended` (process
// termination), this fires on the happy path where a worker opens a PR and
// idles without ending. A persistent role declaring it gets woken with the
// finished worker's done-summary, subject to the same flush-on-idle busy
// policy. See #240.
export const WorkerDoneTriggerSchema = z.object({
  kind: z.literal("worker-done"),
  ...wakeProgramField,
});
export const RoleTriggerSchema = z.discriminatedUnion("kind", [
  CronTriggerSchema,
  FileWatchTriggerSchema,
  WebhookTriggerSchema,
  IssueAssignedTriggerSchema,
  WorkspaceOpenTriggerSchema,
  SessionEndedTriggerSchema,
  WorkerDoneTriggerSchema,
]);
export type RoleTrigger = z.infer<typeof RoleTriggerSchema>;

// Triggers have no native id — they are identified by their canonical
// shape. The id is what workspace config refers to when disabling a
// specific trigger on a specific role-instance. Forward-compatible:
// adding a new kind means extending this switch with a new prefix.
export function triggerId(trigger: RoleTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return `cron:${trigger.expr}`;
    case "webhook":
      return `webhook:${trigger.path}`;
    case "file-watch":
      return `file-watch:${trigger.glob}`;
    case "issue-assigned":
      return trigger.repo === undefined
        ? "issue-assigned"
        : `issue-assigned:${trigger.repo}`;
    case "workspace-open":
      return "workspace-open";
    case "session-ended":
      return "session-ended";
    case "worker-done":
      return "worker-done";
  }
}

export const RoleVersionSchema = z.object({
  id: z.string().uuid(),
  role_id: z.string().uuid(),
  version: z.number().int().positive(),
  framing: z.string(),
  system_prompt: z.string().min(1),
  skills_json: z.string(),
  allowed_tools_json: z.string(),
  allowed_cli_commands_json: z.string(),
  hooks_json: z.string(),
  triggers_json: z.string(),
  seed_refs_json: z.string(),
  wake_programs_json: z.string(),
  // The role's default opening move for a fresh spawn that selects no
  // wake-program (#213). Null = no default → idle. References a program by name
  // in wake_programs_json (or the `idle` built-in).
  default_wake_program: z.string().min(1).nullable(),
  // The engine contract version this row was authored against (#236). Stamped
  // by the store at create time with the engine's current `ENGINE_CONTRACT_VERSION`;
  // a frozen provenance marker the compat check and forward migrations read.
  contract_version: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
});
export type RoleVersion = z.infer<typeof RoleVersionSchema>;

export const CreateRoleRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  permission_mode: PermissionModeSchema.optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  effort: EffortLevelSchema.optional(),
  model: ModelSchema.optional(),
  persistent: z.boolean(),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

export const WorkspaceRoleCeilingSchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  max_concurrent: z.number().int().nonnegative(),
});
export type WorkspaceRoleCeiling = z.infer<typeof WorkspaceRoleCeilingSchema>;

export const SetWorkspaceRoleCeilingRequestSchema = z.object({
  max_concurrent: z.number().int().nonnegative(),
});
export type SetWorkspaceRoleCeilingRequest = z.infer<
  typeof SetWorkspaceRoleCeilingRequestSchema
>;

export const RoleVersionRefSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
});
export type RoleVersionRef = z.infer<typeof RoleVersionRefSchema>;

export const WorkspaceRoleAssignmentSchema = z.object({
  role: RoleSchema,
  max_concurrent: z.number().int().nonnegative(),
  current_version: RoleVersionRefSchema.optional(),
});
export type WorkspaceRoleAssignment = z.infer<typeof WorkspaceRoleAssignmentSchema>;

// #385 — a role is pinned EITHER by a `role_versions` row (current_version_id)
// OR by a commit into the upstream role repo (current_commit). The list/detail
// views mirror that dual-pin: a git-backed role surfaces its real commit ref as
// provenance — it has no version-row uuid, and synthesizing a fake one would
// betray git-as-truth. `version` stays present (the projected view's number) so
// the picker badge has something to render for both pin kinds.
export const RoleListEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  persistent: z.boolean(),
  description: z.string().min(1).optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  current_version_id: z.string().uuid().optional(),
  current_commit: CommitRefSchema.optional(),
  version: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
});
export type RoleListEntry = z.infer<typeof RoleListEntrySchema>;

export const RolesListResponseSchema = z.object({
  roles: z.array(RoleListEntrySchema),
});
export type RolesListResponse = z.infer<typeof RolesListResponseSchema>;

export const RoleDetailVersionSchema = z.object({
  // Absent for a commit-pinned role — its content lives in git, not a row, so
  // `current_commit` carries the provenance instead (see RoleListEntrySchema).
  id: z.string().uuid().optional(),
  current_commit: CommitRefSchema.optional(),
  version: z.number().int().positive(),
  framing: z.string(),
  system_prompt: z.string().min(1),
  skills: z.array(RoleSkillSchema),
  allowed_tools: z.array(z.string().min(1)),
  hooks: z.unknown(),
  triggers: z.array(RoleTriggerSchema),
  prompt_module_refs: z.array(PromptModuleRefSchema),
  wake_programs: z.array(WakeProgramSchema),
  created_at: z.number().int().nonnegative(),
});
export type RoleDetailVersion = z.infer<typeof RoleDetailVersionSchema>;

export const RoleVersionHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
});
export type RoleVersionHistoryEntry = z.infer<typeof RoleVersionHistoryEntrySchema>;

export const RoleDetailResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  persistent: z.boolean(),
  description: z.string().min(1).optional(),
  current_version: RoleDetailVersionSchema,
  version_history: z.array(RoleVersionHistoryEntrySchema),
});
export type RoleDetailResponse = z.infer<typeof RoleDetailResponseSchema>;
