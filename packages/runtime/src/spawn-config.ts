import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffortLevel, HookEventName, Model, PermissionMode } from "@clobber/shared";

export const ALL_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "PreCompact",
] as const satisfies readonly HookEventName[];

const TOOL_MATCHER_EVENTS: ReadonlySet<HookEventName> = new Set([
  "PreToolUse",
  "PostToolUse",
]);

export interface HttpHook {
  readonly type: "http";
  readonly url: string;
  readonly async: boolean;
}

export interface HookHandler {
  readonly matcher?: string;
  readonly hooks: readonly [HttpHook];
}

export type HookSettings = {
  readonly hooks: { readonly [E in HookEventName]?: readonly HookHandler[] };
};

export interface BuildHookSettingsOptions {
  readonly url: string;
  readonly async?: boolean;
  readonly events?: readonly HookEventName[];
}

export function buildHookSettings(opts: BuildHookSettingsOptions): HookSettings {
  const events = opts.events ?? ALL_HOOK_EVENTS;
  const isAsync = opts.async === true;

  const hook: HttpHook = { type: "http", url: opts.url, async: isAsync };

  const hooks: { [E in HookEventName]?: readonly HookHandler[] } = {};
  for (const event of events) {
    const handler: HookHandler = TOOL_MATCHER_EVENTS.has(event)
      ? { matcher: ".*", hooks: [hook] }
      : { hooks: [hook] };
    hooks[event] = [handler];
  }

  return { hooks };
}

// Linux per-argument byte limit (getconf ARG_MAX / per-arg). The cycle path
// composes a large role charter + CYCLE_ORIENTATION_LAYER that historically
// crossed this and caused E2BIG in posix_spawn (#580).
export const MAX_ARG_STRLEN = 131072;

export interface BuildClaudeArgsOptions {
  readonly sessionId: string;
  // When set, resume the existing claude conversation thread (`--resume <id>`)
  // instead of starting a fresh one (`--session-id <id>`). For claude the
  // provider thread id and the clobber session id are the same value.
  readonly resumeThreadId?: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
  readonly effort?: EffortLevel;
  readonly model?: Model;
  // Which of claude's setting sources to load (user / project / local). The
  // workspace owns this — see Workspace.setting_sources. When omitted, the
  // caller is intentionally letting claude default to its own behavior, which
  // includes all three.
  readonly settingSources?: readonly string[];
}

export interface BuildClaudeArgsResult {
  readonly args: string[];
  // Deletes the per-session temp directory written by buildClaudeArgs.
  // Call after the spawned process exits.
  readonly cleanup: () => void;
}

// Build the argv for a claude spawn. Large string args (settings, system prompt)
// are written to per-session temp files and passed as file paths instead of
// inline strings, keeping every single arg under MAX_ARG_STRLEN and avoiding
// posix_spawn E2BIG on long cycle prompts (#580).
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): BuildClaudeArgsResult {
  const args: string[] =
    opts.resumeThreadId === undefined
      ? ["--session-id", opts.sessionId]
      : ["--resume", opts.resumeThreadId];

  const tmpDir = mkdtempSync(join(tmpdir(), "clobber-spawn-"));

  if (opts.settings !== undefined) {
    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(opts.settings), { mode: 0o600 });
    args.push("--settings", settingsPath);
  }

  if (opts.pluginDirs !== undefined) {
    for (const dir of opts.pluginDirs) {
      args.push("--plugin-dir", dir);
    }
  }

  if (opts.settingSources !== undefined && opts.settingSources.length > 0) {
    args.push("--setting-sources", opts.settingSources.join(","));
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.appendSystemPrompt !== undefined) {
    const promptPath = join(tmpDir, "system-prompt");
    writeFileSync(promptPath, opts.appendSystemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt-file", promptPath);
  }
  if (opts.displayName !== undefined && opts.displayName.length > 0) {
    args.push("--name", opts.displayName);
  }
  if (opts.effort !== undefined) {
    args.push("--effort", opts.effort);
  }
  if (opts.model !== undefined) {
    args.push("--model", opts.model);
  }

  args.push(
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-hook-events",
    "--verbose",
  );

  return {
    args,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}
