import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildHookSettings,
  buildClaudeArgs,
  type HookSettings,
} from "./spawn-config.ts";
import { serializeUserMessage } from "./stream-json.ts";
import type { PermissionMode } from "@clobber/shared";

export interface SpawnAgentOptions {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly hookAsync?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly claudeBin?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SpawnedAgent {
  readonly sessionId: string;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly stdin: NodeJS.WritableStream;
  readonly exited: Promise<number | null>;
}

export function spawnAgent(opts: SpawnAgentOptions): SpawnedAgent {
  const sessionId = opts.sessionId === undefined ? randomUUID() : opts.sessionId;

  const settings = resolveSettings(opts);

  const args = buildClaudeArgs({
    sessionId,
    ...(settings === undefined ? {} : { settings }),
    ...(opts.pluginDirs === undefined ? {} : { pluginDirs: opts.pluginDirs }),
    ...(opts.permissionMode === undefined ? {} : { permissionMode: opts.permissionMode }),
    ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
  });

  const bin = opts.claudeBin === undefined ? "claude" : opts.claudeBin;
  const env = opts.env === undefined ? process.env : opts.env;
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${bin}: no pid`);
  }
  if (child.stdin === null) {
    throw new Error(`failed to spawn ${bin}: stdin is null`);
  }

  const stdin = child.stdin;
  stdin.write(serializeUserMessage(opts.prompt));

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  return { sessionId, pid: child.pid, child, stdin, exited };
}

function resolveSettings(opts: SpawnAgentOptions): HookSettings | undefined {
  if (opts.settings !== undefined) return opts.settings;
  if (opts.pluginDirs !== undefined) return undefined;
  return buildHookSettings({ url: opts.hookUrl, async: opts.hookAsync === true });
}
