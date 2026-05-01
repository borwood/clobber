import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createEventStore } from "../src/event-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../src/server.ts";

function buildHarness(spawner: AgentSpawner) {
  const store = createEventStore(":memory:");
  const server = createServer({
    store,
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
  });
  return { server, store };
}

describe("POST /spawn", () => {
  it("calls the injected spawner with prompt, cwd, and the server's hookUrl", async () => {
    const calls: AgentSpawnRequest[] = [];
    const { server, store } = buildHarness((req) => {
      calls.push(req);
      return { sessionId: "fixed-session-id", pid: 4242 };
    });

    const res = await server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        prompt: "do the thing",
        cwd: "/tmp/work",
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash", "Read"],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ sessionId: "fixed-session-id", pid: 4242 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      hookUrl: "http://127.0.0.1:3300/hook",
      prompt: "do the thing",
      cwd: "/tmp/work",
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read"],
    });

    await server.close();
    store.close();
  });

  it("forwards an explicit sessionId to the spawner", async () => {
    const calls: AgentSpawnRequest[] = [];
    const { server, store } = buildHarness((req) => {
      calls.push(req);
      return { sessionId: req.sessionId!, pid: 1 };
    });

    await server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        prompt: "hi",
        cwd: "/tmp",
        sessionId: "00000000-0000-4000-8000-000000000abc",
      },
    });

    expect(calls[0]!.sessionId).toBe("00000000-0000-4000-8000-000000000abc");

    await server.close();
    store.close();
  });

  it("rejects a request missing prompt with 400 and does not spawn", async () => {
    let invocations = 0;
    const { server, store } = buildHarness(() => {
      invocations += 1;
      return { sessionId: "x", pid: 0 };
    });

    const res = await server.inject({
      method: "POST",
      url: "/spawn",
      payload: { cwd: "/tmp" },
    });

    expect(res.statusCode).toBe(400);
    expect(invocations).toBe(0);

    await server.close();
    store.close();
  });

  it("rejects a request missing cwd with 400 and does not spawn", async () => {
    let invocations = 0;
    const { server, store } = buildHarness(() => {
      invocations += 1;
      return { sessionId: "x", pid: 0 };
    });

    const res = await server.inject({
      method: "POST",
      url: "/spawn",
      payload: { prompt: "hi" },
    });

    expect(res.statusCode).toBe(400);
    expect(invocations).toBe(0);

    await server.close();
    store.close();
  });

  it("rejects an unknown permissionMode with 400", async () => {
    const { server, store } = buildHarness(() => ({ sessionId: "x", pid: 0 }));

    const res = await server.inject({
      method: "POST",
      url: "/spawn",
      payload: { prompt: "hi", cwd: "/tmp", permissionMode: "yolo" },
    });

    expect(res.statusCode).toBe(400);

    await server.close();
    store.close();
  });
});
