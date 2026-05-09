import { describe, expect, it } from "bun:test";
import { spawnAgent } from "../src/spawn-agent.ts";

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
