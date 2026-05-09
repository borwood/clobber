import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  buildHookSettings,
  buildClaudeArgs,
  type HookSettings,
} from "./spawn-config.ts";
import { serializeUserMessage } from "./stream-json.ts";
import type { PermissionMode } from "@clobber/shared";
import type { RuntimeCommand } from "./runtime-provider.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import { normalizeCodexExecEvent } from "./codex-jsonl.ts";

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
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
  readonly claudeBin?: string;
  readonly command?: RuntimeCommand;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SpawnedAgent {
  readonly sessionId: string;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly stdin: NodeJS.WritableStream;
  readonly exited: Promise<number | null>;
  readonly runtimeEvents?: AsyncIterable<RuntimeEvent>;
}

export function spawnAgent(opts: SpawnAgentOptions): SpawnedAgent {
  const sessionId = opts.sessionId === undefined ? randomUUID() : opts.sessionId;

  const command = opts.command ?? buildClaudeCommand(sessionId, opts);
  const bin = command.bin;
  const args = [...command.args];
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
  if (opts.command === undefined) {
    stdin.write(serializeUserMessage(opts.prompt));
  } else if (command.stdin !== undefined) {
    stdin.write(command.stdin);
    stdin.end();
  }

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  const runtimeEvents = command.stdoutEventFormat === undefined || child.stdout === null
    ? undefined
    : streamRuntimeEvents(child.stdout, command.stdoutEventFormat);

  return {
    sessionId,
    pid: child.pid,
    child,
    stdin,
    exited,
    ...(runtimeEvents === undefined ? {} : { runtimeEvents }),
  };
}

function buildClaudeCommand(sessionId: string, opts: SpawnAgentOptions): RuntimeCommand {
  const settings = resolveSettings(opts);

  return {
    bin: opts.claudeBin === undefined ? "claude" : opts.claudeBin,
    args: buildClaudeArgs({
      sessionId,
      ...(settings === undefined ? {} : { settings }),
      ...(opts.pluginDirs === undefined ? {} : { pluginDirs: opts.pluginDirs }),
      ...(opts.permissionMode === undefined ? {} : { permissionMode: opts.permissionMode }),
      ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
      ...(opts.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: opts.appendSystemPrompt }),
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
    }),
  };
}

function resolveSettings(opts: SpawnAgentOptions): HookSettings | undefined {
  if (opts.settings !== undefined) return opts.settings;
  if (opts.pluginDirs !== undefined) return undefined;
  return buildHookSettings({ url: opts.hookUrl, async: opts.hookAsync === true });
}

function streamRuntimeEvents(
  stdout: Readable,
  format: RuntimeCommand["stdoutEventFormat"],
): AsyncIterable<RuntimeEvent> {
  const queue: RuntimeEvent[] = [];
  const waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  let done = false;
  let buffer = "";

  const push = (event: RuntimeEvent): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      queue.push(event);
    } else {
      waiter({ value: event, done: false });
    }
  };
  const finish = (): void => {
    done = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  };
  const flushLine = (line: string): void => {
    const raw = line.trim();
    if (raw.length === 0) return;
    if (format === "codex-jsonl") {
      try {
        for (const event of normalizeCodexExecEvent(JSON.parse(raw))) push(event);
      } catch {
        push({ kind: "unknown", eventType: "malformed-json", payload: raw });
      }
    }
  };

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      flushLine(line);
    }
  });
  stdout.on("end", () => {
    flushLine(buffer);
    finish();
  });
  stdout.on("error", finish);

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<RuntimeEvent>> {
          const event = queue.shift();
          if (event !== undefined) {
            return Promise.resolve({ value: event, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}
