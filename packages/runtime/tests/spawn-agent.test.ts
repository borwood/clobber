import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../src/spawn-agent.ts";
import { serializeUserMessage } from "../src/stream-json.ts";

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
