import type { PermissionMode } from "@clobber/shared";
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
  serializeUserMessage,
} from "./stream-json.ts";
import { deriveTranscriptPath } from "./transcript-path.ts";

export type RuntimeProcessLifetime = "session" | "turn";

export interface RuntimeProviderCapabilities {
  readonly processLifetime: RuntimeProcessLifetime;
  readonly livePromptInjection: boolean;
  readonly interrupt: boolean;
  readonly resume: boolean;
}

export interface PrepareBundleOptions {
  readonly bundle: RoleBundleData;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
}

export interface RuntimeSpawnOptions {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly materialized: MaterializedBundle;
  readonly systemPrompt: string;
  readonly displayName?: string;
}

export interface RuntimeResumeOptions extends RuntimeSpawnOptions {
  readonly providerThreadId: string;
}

export interface RuntimeSpawnRequest {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly providerThreadId?: string;
  readonly resume?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly pluginDirs?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
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
  serializeUserPrompt(prompt: string): string;
  serializeInterrupt(requestId: string): string;
  transcriptPath(cwd: string, sessionId: string): string;
}

export const claudeRuntimeProvider: RuntimeProvider = {
  id: "claude",
  capabilities: {
    processLifetime: "session",
    livePromptInjection: true,
    interrupt: true,
    resume: true,
  },
  prepareBundle(opts) {
    return materializeBundle(opts);
  },
  buildSpawnRequest(opts) {
    return {
      hookUrl: opts.hookUrl,
      prompt: opts.prompt,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      ...(opts.permissionMode === undefined
        ? {}
        : { permissionMode: opts.permissionMode }),
      ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
      env: opts.env,
      pluginDirs: [opts.materialized.pluginDir],
      appendSystemPrompt: opts.systemPrompt,
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
    };
  },
  initialProviderThreadId(sessionId) {
    return sessionId;
  },
  serializeUserPrompt: serializeUserMessage,
  serializeInterrupt: serializeInterruptRequest,
  transcriptPath: deriveTranscriptPath,
};

export function buildClaudeRuntimeArgs(opts: {
  readonly sessionId: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
}): string[] {
  return buildClaudeArgs(opts);
}
