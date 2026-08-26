import { z } from "zod";

// The role-authored default wake-program for a trigger — the opening move the
// fired wake composes, mirroring how a trigger's enabled-by-default state is the
// role default for enable/disable. A workspace can override it per trigger via
// `trigger_overrides[roleId].wake_programs` (see workspace.ts). Absent both, the
// wake keeps the legacy synthesized-prompt-as-kick. Shared across kinds so any
// trigger can carry a mapping; `triggerId()` ignores it (the id stays keyed on
// the trigger's identity, so an override keyed by id survives a remap).
const wakeProgramField = { wake_program: z.string().min(1).optional() };

// A workspace-open trigger's optional guard: fire only when `path` (relative
// to the workspace repo root) does NOT exist. Lets a trigger express "first
// open" semantics (#685 bootstrap-interview) without a dedicated trigger kind
// — the sentinel file IS the state machine.
export const TriggerFileAbsentGuardSchema = z.object({
  kind: z.literal("file-absent"),
  path: z.string().min(1),
});
export type TriggerFileAbsentGuard = z.infer<typeof TriggerFileAbsentGuardSchema>;

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
  guard: TriggerFileAbsentGuardSchema.optional(),
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
