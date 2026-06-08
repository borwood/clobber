import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../src/spawn-agent.ts";
import { serializeUserMessage } from "../src/stream-json.ts";
import { MAX_ARG_STRLEN } from "../src/spawn-config.ts";

// A stand-in for the real `claude` binary: ignores its argv and streams stdin
// line-by-line into a capture file, so a test can observe exactly what
// spawnAgent wrote to the child's stdin on the live (command === undefined) path.
function writeFakeClaude(dir: string, capturePath: string): string {
  const bin = join(dir, "fake-claude.sh");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `: > ${JSON.stringify(capturePath)}`,
      "while IFS= read -r line; do",
      `  printf '%s\\n' "$line" >> ${JSON.stringify(capturePath)}`,
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait for the fake binary to boot (it creates the capture file first thing),
// then return whatever it has streamed to stdin once the file is non-empty or
// the deadline passes. Throws if the child never even started.
async function waitForCapture(capturePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(capturePath)) {
    if (Date.now() > deadline) throw new Error("fake claude never started");
    await sleep(20);
  }
  for (;;) {
    const content = readFileSync(capturePath, "utf8");
    if (content.length > 0) return content;
    if (Date.now() > deadline) return content;
    await sleep(20);
  }
}

describe("spawnAgent stdin user-message write", () => {
  it("writes the prompt as a user message on the live resume path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const cap = join(dir, "stdin.log");
    const bin = writeFakeClaude(dir, cap);

    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "open the PR",
      cwd: dir,
      sessionId: "resume-prompted",
      claudeBin: bin,
    });

    const written = await waitForCapture(cap, 3000);
    agent.child.kill();
    rmSync(dir, { recursive: true, force: true });

    expect(written).toBe(serializeUserMessage("open the PR"));
  });

  it("writes NO user message when the resume prompt is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const cap = join(dir, "stdin.log");
    const bin = writeFakeClaude(dir, cap);

    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: undefined,
      cwd: dir,
      sessionId: "resume-bare",
      claudeBin: bin,
    });

    // Give the child time to boot and (incorrectly) write before asserting.
    const written = await waitForCapture(cap, 1500);
    agent.child.kill();
    rmSync(dir, { recursive: true, force: true });

    expect(written).toBe("");
  });
});

describe("spawnAgent runtime command support", () => {
  it("streams Codex JSONL stdout as runtime events", async () => {
    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "unused",
      cwd: process.cwd(),
      sessionId: "local-session-1",
      command: {
        bin: process.execPath,
        args: [
          "-e",
          [
            `console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));`,
            `console.log(JSON.stringify({ type: "turn.completed" }));`,
          ].join("\n"),
        ],
        stdoutEventFormat: "codex-jsonl",
      },
    });

    const events = [];
    for await (const event of agent.runtimeEvents!) events.push(event);

    expect(events).toEqual([
      { kind: "provider-thread-started", providerThreadId: "thread-1" },
      { kind: "turn-completed" },
    ]);
    expect(await agent.startup).toEqual({ ok: true });
    expect(await agent.exited).toBe(0);
  });

  it("reports startup failure when a runtime command exits before readiness", async () => {
    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "unused",
      cwd: process.cwd(),
      sessionId: "local-session-1",
      command: {
        bin: process.execPath,
        args: ["-e", `console.error("no rollout found for thread id thread-1"); process.exit(1);`],
        stdoutEventFormat: "codex-jsonl",
      },
    });

    expect(await agent.startup).toEqual({
      ok: false,
      detail: "no rollout found for thread id thread-1",
    });
    expect(await agent.exited).toBe(1);
  });
});

// AC3 NON-INERT real-path: spawn with an oversized (>MAX_ARG_STRLEN) appendSystemPrompt.
// (a) spawn SUCCEEDS — no E2BIG crash.
// (b) the spawned process ACTUALLY RECEIVES the full prompt via the file arg.
// A stub binary reads its --append-system-prompt-file and --settings args and
// dumps them to capture files so we can verify the content end-to-end.
describe("spawnAgent oversized-arg file delivery (AC3 #580)", () => {
  // Stub binary: reads --append-system-prompt-file and --settings from argv,
  // writes their file contents to separate capture files, then exits.
  function writeArgDumpStub(dir: string, promptCapture: string, settingsCapture: string): string {
    const bin = join(dir, "stub-claude.sh");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env bash",
        "prev=",
        "for arg in \"$@\"; do",
        `  if [[ "$prev" == "--append-system-prompt-file" ]]; then`,
        `    cat "$arg" > ${JSON.stringify(promptCapture)}`,
        "  fi",
        `  if [[ "$prev" == "--settings" ]]; then`,
        `    cat "$arg" > ${JSON.stringify(settingsCapture)}`,
        "  fi",
        "  prev=\"$arg\"",
        "done",
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  async function waitForFile(path: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`file never appeared: ${path}`);
      await sleep(20);
    }
    for (;;) {
      const content = readFileSync(path, "utf8");
      if (content.length > 0) return content;
      if (Date.now() > deadline) return content;
      await sleep(20);
    }
  }

  it("(a) succeeds without E2BIG and (b) delivers full oversized prompt via file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac3-spawn-"));
    const promptCapture = join(dir, "prompt.cap");
    const settingsCapture = join(dir, "settings.cap");
    const bin = writeArgDumpStub(dir, promptCapture, settingsCapture);

    // Oversized: well above MAX_ARG_STRLEN=131072. Simulates the cycle path's
    // large role charter + CYCLE_ORIENTATION_LAYER that triggered E2BIG.
    const bigPrompt = "cycle-orientation:\n" + "x".repeat(133000);
    expect(Buffer.byteLength(bigPrompt)).toBeGreaterThan(MAX_ARG_STRLEN);

    // (a) spawn must not throw — no E2BIG
    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: undefined,
      cwd: dir,
      sessionId: "ac3-session",
      claudeBin: bin,
      appendSystemPrompt: bigPrompt,
    });

    expect(agent.pid).toBeGreaterThan(0);
    await agent.exited;

    // (b) the stub reads the file arg and writes its content to the capture file;
    // verify the full prompt arrived intact.
    const received = await waitForFile(promptCapture, 5000);
    expect(received).toBe(bigPrompt);

    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers full settings via file when settings is provided alongside oversized prompt", async () => {
    const { buildHookSettings } = await import("../src/spawn-config.ts");
    const settings = buildHookSettings({ url: "http://127.0.0.1:3300/hook" });

    const dir = mkdtempSync(join(tmpdir(), "ac3-settings-"));
    const promptCapture = join(dir, "prompt.cap");
    const settingsCapture = join(dir, "settings.cap");
    const bin = writeArgDumpStub(dir, promptCapture, settingsCapture);

    const bigPrompt = "x".repeat(133000);

    const agent = spawnAgent({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: undefined,
      cwd: dir,
      sessionId: "ac3-settings-session",
      claudeBin: bin,
      appendSystemPrompt: bigPrompt,
      settings,
    });

    expect(agent.pid).toBeGreaterThan(0);
    await agent.exited;

    const receivedSettings = await waitForFile(settingsCapture, 5000);
    expect(JSON.parse(receivedSettings)).toEqual(settings);

    rmSync(dir, { recursive: true, force: true });
  });
});
