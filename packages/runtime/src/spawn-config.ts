import type { HookEventName, PermissionMode } from "@clobber/shared";

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

export interface BuildClaudeArgsOptions {
  readonly sessionId: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
}

export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = ["--session-id", opts.sessionId];

  if (opts.settings !== undefined) {
    args.push("--settings", JSON.stringify(opts.settings));
  }

  if (opts.pluginDirs !== undefined) {
    for (const dir of opts.pluginDirs) {
      args.push("--plugin-dir", dir);
    }
  }

  args.push("--setting-sources", "user");

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.displayName !== undefined && opts.displayName.length > 0) {
    args.push("--name", opts.displayName);
  }

  args.push(
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-hook-events",
    "--verbose",
  );

  return args;
}
