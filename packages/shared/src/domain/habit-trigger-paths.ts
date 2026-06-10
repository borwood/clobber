import { z } from "zod";
import { AGENT_STATES } from "./agent-status.ts";
import { SessionStartSourceSchema } from "../hooks/payloads.ts";

// #398 habit primitive — the validated EVENT TREE, discriminated on `path`. Each
// member is one trigger-path plus its PREDICATE fields; the common habit config
// (name/enabled/rand/scope/action) is layered on in habit.ts so this discriminant
// stays clean.
//
// TWO AXES (re-pin, 2026-05-31):
//   axis A — who evaluates (the CATEGORY): `self.*` is harness-fired (Claude Code
//            hooks → settings.json, in-session); `system.*`/`workspace.*` are
//            engine-fired (the clobber server observes the event).
//   axis B — scope (a habit FIELD, not a branch): self vs cross-agent/workspace.
//            Lives in habit.ts's common fields, defaulting to "self".
//
// Source markers (the load-bearing honesty of this pass):
//   [V]  verified against clobber code or the Claude Code hooks reference, and
//        modeled/wired today (payloads.ts:83-92 enumerate the 8 wired events).
//   [V*] the EVENT exists in the hooks reference but clobber does not model/wire
//        it yet — enumerated so wiring one later is additive, not a schema bump.
//   [S]  speculative — no source substrate exists today (synthesized or blocked).
//
// `match` mirrors Claude matcher semantics: exact | '|'-list | regex.
const match = z.string().min(1).optional();

// ── system.*  — engine-fired, out-of-session, clobber scheduler ───────────────
const SystemCron = z.object({
  path: z.literal("system.cron"),
  expr: z.string().min(1), // `cron` trigger (role.ts) [V]
});
const SystemWebhook = z.object({
  path: z.literal("system.webhook"),
  endpoint: z.string().min(1).startsWith("/"), // `webhook` trigger (role.ts) [V]
});

// ── workspace.*  — engine-fired, workspace/agent lifecycle, clobber server ────
const WorkspaceOpen = z.object({
  path: z.literal("workspace.open"), // `workspace-open` trigger, debounced [V]
  debounce_ms: z.number().int().nonnegative().optional(),
});
const WorkspaceWorkerDone = z.object({
  path: z.literal("workspace.worker-done"), // `worker-done` (clobber status done) [V] #240
});
const WorkspaceSessionEnded = z.object({
  path: z.literal("workspace.session-ended"), // SessionEnd → fireSessionEnded [V] #171
});
// Re-pin amendment 4: status-change is the clobber server observing a `clobber
// status` POST — the SERVER is the evaluator, so it is engine-fired, not self.*.
// Self-only vs cross-agent is the `scope` field (grant-enforced), not the path.
const WorkspaceStatusChange = z.object({
  path: z.literal("workspace.status-change"), // `clobber status` POST [V]
  to: z.enum(AGENT_STATES).optional(),
});

// ── self.*  — in-session, harness-fired (Claude Code hooks → settings.json) ────
const SelfSessionMessage = z.object({
  path: z.literal("self.session-message"),
  // role:"user" → UserPromptSubmit [V]; role:"assistant" → MessageDisplay [V*].
  role: z.enum(["user", "assistant"]).default("user"),
  match, // regex on prompt/content — evaluated receiver-side (no native matcher)
});
const SelfToolUse = z.object({
  path: z.literal("self.tool-use"),
  phase: z.enum(["pre", "post"]).default("pre"), // PreToolUse | PostToolUse [V]
  match,       // tool_name — rides the native settings.json matcher
  match_path:    z.string().min(1).optional(), // regex vs resolved absolute file_path (Write|Edit|MultiEdit)
  match_command: z.string().min(1).optional(), // regex vs tool_input.command (Bash)
});
const SelfSessionStart = z.object({
  path: z.literal("self.session-start"),
  source: SessionStartSourceSchema.optional(), // SessionStart {startup|resume|clear|compact} [V]
});
const SelfCompaction = z.object({
  path: z.literal("self.compaction"),
  phase: z.enum(["pre", "post"]).default("pre"), // pre → PreCompact [V]; post → PostCompact [V*]
});
const SelfStop = z.object({
  path: z.literal("self.stop"), // Stop, turn boundary [V]
});
// Re-pin amendment 3: desk-change is harness-fired (Claude-native FileChanged),
// in-session. SessionStart `watchPaths` output declares what to watch — no
// server-side watcher, the dead `file-watch` trigger stays dead.
const SelfDeskChange = z.object({
  path: z.literal("self.desk-change"),
  glob: z.string().min(1), // FileChanged literal-filename / glob [V*]
});
const SelfSessionAge = z.object({
  // [S] no native wall-clock hook — synthesized from a Stop-hook elapsed check or
  // a server timer. Enumerated here; firing is a later phase.
  path: z.literal("self.session-age"),
  after_ms: z.number().int().positive(),
});
const SelfSessionLength = z.object({
  // [V] Wired in #184: evaluated at PostToolUse + UserPromptSubmit via bounded
  // transcript tail-read → computeContextLength. One-shot per (session, habit).
  path: z.literal("self.session-length"),
  max_tokens: z.number().int().positive(),
});

// ── self.*  — [V*] extended surface the richer hooks reference unlocks. None
// wired in v1; enumerated so wiring one later is additive, not a schema bump. ──
const SelfSubagentStop = z.object({
  path: z.literal("self.subagent-stop"), // SubagentStop {agent_type} [V*]
  match, // agent_type
});
const SelfToolFailure = z.object({
  path: z.literal("self.tool-failure"), // PostToolUseFailure {tool_error} [V*]
  match, // tool_name
});
const SelfNotification = z.object({
  path: z.literal("self.notification"), // Notification {notification_type} [V*] (wired [V])
  match, // notification_type, e.g. idle_prompt
});
const SelfPermission = z.object({
  path: z.literal("self.permission"), // PermissionRequest | PermissionDenied [V*]
  phase: z.enum(["request", "denied"]).default("request"),
});
const SelfCwdChange = z.object({
  path: z.literal("self.cwd-change"), // CwdChanged {old_cwd,new_cwd} [V*]
});
const SelfConfigChange = z.object({
  path: z.literal("self.config-change"), // ConfigChange {config_source incl "skills"} [V*]
  match, // config_source
});

export const TriggerPathSchema = z.discriminatedUnion("path", [
  SystemCron,
  SystemWebhook,
  WorkspaceOpen,
  WorkspaceWorkerDone,
  WorkspaceSessionEnded,
  WorkspaceStatusChange,
  SelfSessionMessage,
  SelfToolUse,
  SelfSessionStart,
  SelfCompaction,
  SelfStop,
  SelfDeskChange,
  SelfSessionAge,
  SelfSessionLength,
  SelfSubagentStop,
  SelfToolFailure,
  SelfNotification,
  SelfPermission,
  SelfCwdChange,
  SelfConfigChange,
]);
export type TriggerPath = z.infer<typeof TriggerPathSchema>;

// The bare path literals — the master template's enumeration and the
// presence-based grant key off these.
export const TRIGGER_PATHS = [
  "system.cron",
  "system.webhook",
  "workspace.open",
  "workspace.worker-done",
  "workspace.session-ended",
  "workspace.status-change",
  "self.session-message",
  "self.tool-use",
  "self.session-start",
  "self.compaction",
  "self.stop",
  "self.desk-change",
  "self.session-age",
  "self.session-length",
  "self.subagent-stop",
  "self.tool-failure",
  "self.notification",
  "self.permission",
  "self.cwd-change",
  "self.config-change",
] as const;
export const TriggerPathLiteralSchema = z.enum(TRIGGER_PATHS);
export type TriggerPathLiteral = z.infer<typeof TriggerPathLiteralSchema>;
