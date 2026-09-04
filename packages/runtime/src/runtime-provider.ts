import type {
  ClobberPromptTag,
  EffortLevel,
  InSessionHabitsCapability,
  Model,
  PermissionMode,
} from "@clobber/shared";
import {
  buildClaudeArgs,
  type HookSettings,
} from "./spawn-config.ts";
import {
  materializeBundle,
  type MaterializedBundle,
  type RoleBundleData,
} from "./materialize-bundle.ts";
import {
  serializeInterruptRequest,
  serializeSetEffortRequest,
  serializeSetModelRequest,
  serializeUserMessage,
} from "./stream-json.ts";
import { deriveTranscriptPath } from "./transcript-path.ts";

export type RuntimeProcessLifetime = "session" | "turn";
export type RuntimeStdoutEventFormat = "codex-jsonl";

export interface RuntimeCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly stdoutEventFormat?: RuntimeStdoutEventFormat;
}

// #337/#271 — `inSessionHabits` (from Phase 0's InSessionHabitsCapability) joins
// the capability set: does this runtime emit the in-session reactive hooks that
// `self.*` habits compile to? claude: true · codex (turn-based, no hooks): false.
export interface RuntimeProviderCapabilities extends InSessionHabitsCapability {
  readonly processLifetime: RuntimeProcessLifetime;
  readonly livePromptInjection: boolean;
  readonly interrupt: boolean;
  readonly resume: boolean;
  // Can retune a live process's model/effort via control requests. Runtimes
  // without it still honor recorded dials at the next respawn/turn.
  readonly reconfigure: boolean;
  // True when the runtime cannot start without a prompt (e.g. Codex exec).
  readonly requiresPrompt?: boolean;
}

export interface PrepareBundleOptions {
  readonly bundle: RoleBundleData;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
}

export interface RuntimeSpawnOptions {
  readonly hookUrl: string;
  // Absent on a bare resume: no user turn to inject. A fresh spawn always
  // carries one.
  readonly prompt: string | undefined;
  readonly promptTag?: ClobberPromptTag;
  readonly cwd: string;
  readonly sessionId: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly env: NodeJS.ProcessEnv;
  readonly materialized: MaterializedBundle;
  readonly systemPrompt: string;
  readonly displayName?: string;
  readonly settingSources?: readonly string[];
}

export interface RuntimeResumeOptions extends RuntimeSpawnOptions {
  readonly providerThreadId: string;
}

export interface RuntimeSpawnRequest {
  readonly hookUrl: string;
  readonly prompt?: string;
  readonly promptTag?: ClobberPromptTag;
  readonly cwd: string;
  readonly sessionId: string;
  readonly providerThreadId?: string;
  readonly resume?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly env: NodeJS.ProcessEnv;
  readonly pluginDirs?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
  readonly command?: RuntimeCommand;
  readonly settingSources?: readonly string[];
}

/**
 * Runtime providers own protocol details for one agent runtime. Clobber core
 * should depend on this API, not on Claude/Codex command-line or wire formats.
 */
export interface RuntimeProvider {
  readonly id: string;
  readonly capabilities: RuntimeProviderCapabilities;
  prepareBundle(opts: PrepareBundleOptions): MaterializedBundle;
  buildSpawnRequest(opts: RuntimeSpawnOptions): RuntimeSpawnRequest;
  buildResumeRequest?(opts: RuntimeResumeOptions): RuntimeSpawnRequest;
  initialProviderThreadId(sessionId: string): string | undefined;
  serializeUserPrompt(prompt: string, tag?: ClobberPromptTag): string;
  serializeInterrupt(requestId: string): string;
  serializeSetModel(requestId: string, model: Model): string;
  serializeSetEffort(requestId: string, effort: EffortLevel): string;
  transcriptPath(cwd: string, sessionId: string): string;
}

// #699 — the worker role's boot-tasks phase plan drives TaskCreate/TaskUpdate
// (the harness's task-tracking tool family), which the server hooks into
// phase-transition events (task-event-handler.ts). That tool family is only
// ToolSearch-reachable in a claude spawn when CLAUDE_CODE_ENABLE_TODO_TOOLS=1
// is set on the child process env — confirmed empirically against the
// installed claude binary. --allowedTools is a permission allowlist; it does
// not, on its own, register the tool. A caller-supplied value in opts.env
// still wins (e.g. a test or an operator opting a session out).
function withTaskToolRegistration(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", ...env };
}

export const claudeRuntimeProvider: RuntimeProvider = {
  id: "claude",
  capabilities: {
    processLifetime: "session",
    livePromptInjection: true,
    interrupt: true,
    resume: true,
    reconfigure: true,
    inSessionHabits: true,
  },
  prepareBundle(opts) {
    return materializeBundle({ ...opts, inSessionHabits: true });
  },
  buildSpawnRequest(opts) {
    return {
      hookUrl: opts.hookUrl,
      ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
      ...(opts.promptTag === undefined ? {} : { promptTag: opts.promptTag }),
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      ...(opts.permissionMode === undefined
        ? {}
        : { permissionMode: opts.permissionMode }),
      ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
      ...(opts.effort === undefined ? {} : { effort: opts.effort }),
      ...(opts.model === undefined ? {} : { model: opts.model }),
      env: withTaskToolRegistration(opts.env),
      pluginDirs: [opts.materialized.pluginDir],
      appendSystemPrompt: opts.systemPrompt,
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      ...(opts.settingSources === undefined
        ? {}
        : { settingSources: opts.settingSources }),
    };
  },
  buildResumeRequest(opts) {
    // Resume reuses the spawn request verbatim but flags the existing thread so
    // spawn-agent emits `claude --resume <id>` instead of `--session-id <id>`.
    // The follow-up prompt still flows in over stdin as a user message.
    return {
      ...claudeRuntimeProvider.buildSpawnRequest(opts),
      providerThreadId: opts.providerThreadId,
      resume: true,
    };
  },
  initialProviderThreadId(sessionId) {
    return sessionId;
  },
  serializeUserPrompt: serializeUserMessage,
  serializeInterrupt: serializeInterruptRequest,
  serializeSetModel: serializeSetModelRequest,
  serializeSetEffort: serializeSetEffortRequest,
  transcriptPath: deriveTranscriptPath,
};

export const codexRuntimeProvider: RuntimeProvider = {
  id: "codex",
  capabilities: {
    processLifetime: "turn",
    livePromptInjection: false,
    interrupt: false,
    resume: true,
    reconfigure: false,
    inSessionHabits: false,
    requiresPrompt: true,
  },
  prepareBundle(opts) {
    return materializeBundle({ ...opts, inSessionHabits: false });
  },
  buildSpawnRequest(opts) {
    return buildCodexRequest(opts, {
      args: ["exec", "--json", "--cd", opts.cwd],
    });
  },
  buildResumeRequest(opts) {
    return buildCodexRequest(opts, {
      args: ["exec", "resume", opts.providerThreadId, "--json"],
      providerThreadId: opts.providerThreadId,
      resume: true,
    });
  },
  initialProviderThreadId() {
    return undefined;
  },
  serializeUserPrompt() {
    throw new Error("Codex runtime does not support live prompt injection");
  },
  serializeInterrupt() {
    throw new Error("Codex runtime does not support interrupts");
  },
  serializeSetModel() {
    throw new Error("Codex runtime does not support live reconfigure");
  },
  serializeSetEffort() {
    throw new Error("Codex runtime does not support live reconfigure");
  },
  transcriptPath(cwd, sessionId) {
    return `${cwd}/.clobber/codex-transcripts/${sessionId}.jsonl`;
  },
};

function buildCodexRequest(
  opts: RuntimeSpawnOptions,
  commandOpts: {
    readonly args: string[];
    readonly providerThreadId?: string;
    readonly resume?: boolean;
  },
): RuntimeSpawnRequest {
  if (opts.prompt === undefined) {
    throw new Error("Codex runtime requires a prompt; bare resume is unsupported");
  }
  const prompt = buildCodexPrompt(opts.systemPrompt, opts.prompt);
  const args = [...commandOpts.args];
  if (opts.permissionMode === "bypassPermissions") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push(prompt);
  return {
    hookUrl: opts.hookUrl,
    prompt,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    ...(commandOpts.providerThreadId === undefined
      ? {}
      : { providerThreadId: commandOpts.providerThreadId }),
    ...(commandOpts.resume === undefined ? {} : { resume: commandOpts.resume }),
    ...(opts.permissionMode === undefined
      ? {}
      : { permissionMode: opts.permissionMode }),
    ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
    env: opts.env,
    appendSystemPrompt: opts.systemPrompt,
    ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
    command: {
      bin: "codex",
      args,
      stdoutEventFormat: "codex-jsonl",
    },
  };
}

function buildCodexPrompt(systemPrompt: string, prompt: string): string {
  return [
    "<clobber-role-system-prompt>",
    systemPrompt,
    "</clobber-role-system-prompt>",
    "",
    prompt,
  ].join("\n");
}

export function buildClaudeRuntimeArgs(opts: {
  readonly sessionId: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
}): import("./spawn-config.ts").BuildClaudeArgsResult {
  return buildClaudeArgs(opts);
}
