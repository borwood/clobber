import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import {
  DEFAULT_BOOT_CONTEXT_PROVIDER,
  type BootContext,
} from "@clobber/shared";
import type { AgentSpawner, AgentSpawnRequest } from "../src/types.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-spawn-boot-ctx-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  calls: AgentSpawnRequest[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const sessionTokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    const stdin = new PassThrough();
    stdin.resume();
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9400,
      exited: new Promise<number | null>(() => {}),
      stdin,
      kill: () => {},
    };
  };
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://127.0.0.1:3300/hook",
    apiBase: "http://127.0.0.1:3300",
    cliEntry: "/abs/cli/index.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

const MARK_START = "[Workspace context]";
const MARK_END = "[End of workspace context]";

describe("spawn — boot-context provider injection (#166)", () => {
  it("exec provider stdout is injected between workspace-context markers, before the prompt", async () => {
    const h = buildHarness();
    const sinkPath = join(repoPath, "boot-ctx-stdin.json");
    const ws = h.workspaces.create({
      name: "ws-exec",
      repo_path: repoPath,
      boot_context_provider: {
        kind: "exec",
        command: "sh",
        args: ["-c", `cat > ${sinkPath}; printf 'ACCUMULATED-WISDOM'`],
      },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "ship the issue", label: "task" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.calls).toHaveLength(1);
    const prompt = h.calls[0]!.prompt!;
    expect(prompt).toContain(MARK_START);
    expect(prompt).toContain("ACCUMULATED-WISDOM");
    expect(prompt).toContain(MARK_END);
    // Workspace framing comes first, the task body last.
    expect(prompt.indexOf(MARK_START)).toBeLessThan(prompt.indexOf("ship the issue"));
    expect(prompt.endsWith("ship the issue")).toBe(true);

    // The provider received the BootContext as JSON on stdin.
    const ctx = JSON.parse(readFileSync(sinkPath, "utf8")) as BootContext;
    expect(ctx.workspace_id).toBe(ws.id);
    expect(ctx.role_id).toBe(role.id);
    expect(ctx.role_name).toBe("worker");
    expect(ctx.persistent).toBe(false);
    expect(typeof ctx.agent_id).toBe("string");

    await teardown(h);
  });

  it("workspace context is placed before office context for a persistent agent", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws-order",
      repo_path: repoPath,
      boot_context_provider: {
        kind: "exec",
        command: "sh",
        args: ["-c", "printf 'DURABLE-FRAMING'"],
      },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "boot" },
    });
    expect(res.statusCode).toBe(200);

    const prompt = h.calls[0]!.prompt!;
    expect(prompt).toContain("DURABLE-FRAMING");
    expect(prompt).toContain("[Previously in this office]");
    // Order: workspace context, then office context, then the task.
    expect(prompt.indexOf(MARK_START)).toBeLessThan(prompt.indexOf("[Previously in this office]"));
    expect(prompt.indexOf("[Previously in this office]")).toBeLessThan(prompt.indexOf("do work"));

    await teardown(h);
  });

  it("noop provider (the default) injects nothing — no markers, prompt unchanged", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-noop", repo_path: repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "task body", label: "task" },
    });
    expect(res.statusCode).toBe(200);

    const prompt = h.calls[0]!.prompt;
    expect(prompt).toBe("task body");
    expect(prompt).not.toContain(MARK_START);

    await teardown(h);
  });

  it("a provider that exits non-zero fails the spawn loudly (no soft-fail, no injection)", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws-boom",
      repo_path: repoPath,
      boot_context_provider: {
        kind: "exec",
        command: "sh",
        args: ["-c", "echo nope >&2; exit 7"],
      },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "x", label: "task" },
    });
    expect(res.statusCode).toBe(500);
    expect(h.calls).toHaveLength(0);

    await teardown(h);
  });

  it("a new workspace defaults to the noop boot-context provider", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-default", repo_path: repoPath });
    expect(ws.boot_context_provider).toEqual({ ...DEFAULT_BOOT_CONTEXT_PROVIDER });
    expect(ws.boot_context_provider.kind).toBe("noop");
    await teardown(h);
  });

  it("accepts a custom boot_context_provider on creation", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws-custom",
      repo_path: repoPath,
      boot_context_provider: { kind: "noop" },
    });
    expect(ws.boot_context_provider).toEqual({ kind: "noop" });
    await teardown(h);
  });
});

describe("spawn — boot-context provider over http (#166)", () => {
  let captureServer: FastifyInstance;
  let captureUrl: string;
  let captured: Array<{ body: BootContext }>;

  beforeEach(async () => {
    captured = [];
    captureServer = Fastify({ logger: false });
    captureServer.post("/context", async (req, reply) => {
      captured.push({ body: req.body as BootContext });
      reply.code(200);
      reply.header("content-type", "text/plain");
      return "HTTP-WISDOM";
    });
    await captureServer.listen({ port: 0, host: "127.0.0.1" });
    const address = captureServer.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected AddressInfo");
    }
    captureUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await captureServer.close();
  });

  it("POSTs the boot context and injects the response body between markers", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws-http",
      repo_path: repoPath,
      boot_context_provider: { kind: "http", url: `${captureUrl}/context` },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "task" },
    });
    expect(res.statusCode).toBe(200);

    expect(captured.length).toBe(1);
    expect(captured[0]!.body.workspace_id).toBe(ws.id);
    expect(captured[0]!.body.role_name).toBe("worker");

    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain(MARK_START);
    expect(prompt).toContain("HTTP-WISDOM");
    expect(prompt).toContain(MARK_END);

    await teardown(h);
  });
});
