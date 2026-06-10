import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  buildHookSettings,
  buildClaudeArgs,
  type HookSettings,
} from "./spawn-config.ts";
import { serializeUserMessage } from "./stream-json.ts";
import type { ClobberPromptTag, EffortLevel, Model, PermissionMode } from "@clobber/shared";
import type { RuntimeCommand } from "./runtime-provider.ts";
import type { RuntimeEvent, RuntimeStartupResult } from "./runtime-events.ts";
import { normalizeCodexExecEvent } from "./codex-jsonl.ts";

export interface SpawnAgentOptions {
  readonly hookUrl: string;
  // Absent on a bare resume: nothing is written to the child's stdin, so the
  // resumed thread idles instead of burning a turn on an empty user message.
  readonly prompt: string | undefined;
  readonly promptTag?: ClobberPromptTag;
  readonly cwd: string;
  readonly sessionId?: string;
  // Resume an existing claude conversation thread instead of starting fresh.
  readonly resumeThreadId?: string;
  readonly settings?: HookSettings;
  readonly pluginDirs?: readonly string[];
  readonly hookAsync?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly appendSystemPrompt?: string;
  readonly displayName?: string;
  readonly claudeBin?: string;
  readonly command?: RuntimeCommand;
  readonly env?: NodeJS.ProcessEnv;
  readonly settingSources?: readonly string[];
}

export interface SpawnedAgent {
  readonly sessionId: string;
  readonly pid: number;
  readonly child: ChildProcess;
  readonly stdin: NodeJS.WritableStream;
  readonly exited: Promise<number | null>;
  readonly runtimeEvents?: AsyncIterable<RuntimeEvent>;
  readonly startup?: Promise<RuntimeStartupResult>;
}

export function spawnAgent(opts: SpawnAgentOptions): SpawnedAgent {
  const sessionId = opts.sessionId === undefined ? randomUUID() : opts.sessionId;

  let command: RuntimeCommand;
  let cleanupOnce: () => void;
  if (opts.command !== undefined) {
    command = opts.command;
    cleanupOnce = () => {};
  } else {
    const built = buildClaudeCommand(sessionId, opts);
    command = built.command;
    let cleaned = false;
    cleanupOnce = () => {
      if (cleaned) return;
      cleaned = true;
      built.cleanup();
    };
  }
  const bin = command.bin;
  const args = [...command.args];
  const env = opts.env === undefined ? process.env : opts.env;
  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  } catch (e) {
    cleanupOnce();
    throw e;
  }

  if (child.pid === undefined) {
    child.on("error", () => {});
    cleanupOnce();
    throw new Error(`failed to spawn ${bin}: no pid`);
  }
  if (child.stdin === null) {
    child.on("error", () => {});
    cleanupOnce();
    throw new Error(`failed to spawn ${bin}: stdin is null`);
  }

  const stdin = child.stdin;
  if (opts.command === undefined) {
    if (opts.prompt !== undefined) {
      stdin.write(serializeUserMessage(opts.prompt, opts.promptTag));
    }
  } else if (command.stdin !== undefined) {
    stdin.write(command.stdin);
    stdin.end();
  }

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      cleanupOnce();
      resolve(code);
    });
  });

  const stderr = collectStderr(child.stderr);
  const runtimeStream = command.stdoutEventFormat === undefined || child.stdout === null
    ? undefined
    : streamRuntimeEvents(child.stdout, command.stdoutEventFormat, exited, stderr);

  return {
    sessionId,
    pid: child.pid,
    child,
    stdin,
    exited,
    ...(runtimeStream === undefined
      ? {}
      : { runtimeEvents: runtimeStream.events, startup: runtimeStream.startup }),
  };
}

function buildClaudeCommand(
  sessionId: string,
  opts: SpawnAgentOptions,
): { command: RuntimeCommand; cleanup: () => void } {
  const settings = resolveSettings(opts);

  const { args, cleanup } = buildClaudeArgs({
    sessionId,
    ...(opts.resumeThreadId === undefined ? {} : { resumeThreadId: opts.resumeThreadId }),
    ...(settings === undefined ? {} : { settings }),
    ...(opts.pluginDirs === undefined ? {} : { pluginDirs: opts.pluginDirs }),
    ...(opts.permissionMode === undefined ? {} : { permissionMode: opts.permissionMode }),
    ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
    ...(opts.effort === undefined ? {} : { effort: opts.effort }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: opts.appendSystemPrompt }),
    ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
    ...(opts.settingSources === undefined
      ? {}
      : { settingSources: opts.settingSources }),
  });

  return {
    command: {
      bin: opts.claudeBin === undefined ? "claude" : opts.claudeBin,
      args,
    },
    cleanup,
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
  exited: Promise<number | null>,
  stderr: () => string,
): {
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly startup: Promise<RuntimeStartupResult>;
} {
  const queue: RuntimeEvent[] = [];
  const waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  let done = false;
  let buffer = "";
  let startupResolved = false;
  let resolveStartup!: (result: RuntimeStartupResult) => void;
  const startup = new Promise<RuntimeStartupResult>((resolve) => {
    resolveStartup = resolve;
  });

  const push = (event: RuntimeEvent): void => {
    if (!startupResolved && isStartupReady(event)) {
      startupResolved = true;
      resolveStartup({ ok: true });
    }
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
  exited.then((code) => {
    if (!startupResolved && code !== 0) {
      startupResolved = true;
      const detail = stderr();
      resolveStartup({
        ok: false,
        detail: detail.length === 0
          ? "runtime process exited before startup"
          : detail,
      });
    }
    if (!startupResolved) {
      startupResolved = true;
      resolveStartup({ ok: true });
    }
  });

  return {
    events: {
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
    },
    startup,
  };
}

function isStartupReady(event: RuntimeEvent): boolean {
  return event.kind === "provider-thread-started" || event.kind === "turn-started";
}

function collectStderr(stderr: Readable | null): () => string {
  if (stderr === null) return () => "";
  let buffer = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    buffer += chunk;
  });
  return () => buffer.trim();
}
