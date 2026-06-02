import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import {
  createFinalReportConsumer,
  createFinalReportConsumerStateStore,
  type FinalReportConsumer,
} from "../src/final-report-consumer.ts";
import {
  DEFAULT_FINAL_REPORT_CALLBACK,
  type FinalReportPayload,
} from "@clobber/shared";

interface Harness {
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  agents: ReturnType<typeof createAgentStore>;
  sessions: ReturnType<typeof createSessionStore>;
  agentStatusLog: ReturnType<typeof createAgentStatusLogStore>;
  stateStore: ReturnType<typeof createFinalReportConsumerStateStore>;
  consumer: FinalReportConsumer;
}

interface SeededAgent {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-final-report-consumer-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const agentStatusLog = createAgentStatusLogStore(db);
  const stateStore = createFinalReportConsumerStateStore(db);
  const consumer = createFinalReportConsumer({
    db,
    workspaces,
    agentStatusLog,
    stateStore,
  });
  return {
    db,
    workspaces,
    roles,
    agents,
    sessions,
    agentStatusLog,
    stateStore,
    consumer,
  };
}

function teardown(h: Harness): void {
  h.consumer.stop();
  h.db.close();
}

function seed(h: Harness, opts: { wsName?: string } = {}): SeededAgent {
  const name = opts.wsName ?? "ws-default";
  const ws = h.workspaces.create({ name, repo_path: repoPath });
  const role = h.roles.create({ name: `worker-${name}`, persistent: false });
  const agent = h.agents.create({
    workspace_id: ws.id,
    role_id: role.id,
    label: "worker-1",
  });
  const sessionId = `session-${name}-0001`;
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 4242,
  });
  return { workspaceId: ws.id, agentId: agent.id, sessionId };
}

function writeFinalReport(
  h: Harness,
  seeded: SeededAgent,
  report: FinalReportPayload["report"],
): void {
  h.agentStatusLog.append({
    agent_id: seeded.agentId,
    session_id: seeded.sessionId,
    kind: "final-report",
    state: "final",
    summary: "stub summary",
    details: report,
  });
}

function callbackErrorsBySession(h: Harness, sessionId: string): Array<{
  agent_id: string;
  session_id: string;
  kind: string;
  state: string;
  summary: string;
  details: Record<string, unknown> | null;
}> {
  const rows = h.db
    .prepare(
      `SELECT agent_id, session_id, kind, state, summary, details_json
         FROM agent_status_log
         WHERE session_id = ? AND kind = 'callback-error'
         ORDER BY id ASC`,
    )
    .all(sessionId) as Array<{
      agent_id: string;
      session_id: string;
      kind: string;
      state: string;
      summary: string;
      details_json: string | null;
    }>;
  return rows.map((r) => ({
    agent_id: r.agent_id,
    session_id: r.session_id,
    kind: r.kind,
    state: r.state,
    summary: r.summary,
    details: r.details_json === null
      ? null
      : (JSON.parse(r.details_json) as Record<string, unknown>),
  }));
}

describe("FinalReportConsumer — default noop callback", () => {
  it("processes a final-report row but takes no external action", async () => {
    const h = buildHarness();
    const seeded = seed(h);
    writeFinalReport(h, seeded, { well: "tests landed clean" });

    const result = await h.consumer.drainOnce();

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(callbackErrorsBySession(h, seeded.sessionId)).toEqual([]);
    expect(h.stateStore.getLastConsumedId(seeded.workspaceId)).toBeGreaterThan(0);

    teardown(h);
  });

  it("does not reprocess the same row on subsequent drains (idempotency)", async () => {
    const h = buildHarness();
    const seeded = seed(h);
    writeFinalReport(h, seeded, { well: "alpha" });

    const first = await h.consumer.drainOnce();
    expect(first.processed).toBe(1);

    const second = await h.consumer.drainOnce();
    expect(second.processed).toBe(0);

    teardown(h);
  });

  it("scopes processing per workspace — a report in WS A does not advance WS B's cursor", async () => {
    const h = buildHarness();
    const a = seed(h, { wsName: "ws-a" });
    const b = seed(h, { wsName: "ws-b" });
    writeFinalReport(h, a, { well: "in A" });

    const first = await h.consumer.drainOnce();
    expect(first.processed).toBe(1);

    expect(h.stateStore.getLastConsumedId(a.workspaceId)).toBeGreaterThan(0);
    // B has had no reports — its cursor stays at 0
    expect(h.stateStore.getLastConsumedId(b.workspaceId)).toBe(0);

    // Now a report in B; A's cursor must not move because of B
    writeFinalReport(h, b, { well: "in B" });
    const second = await h.consumer.drainOnce();
    expect(second.processed).toBe(1);

    teardown(h);
  });
});

describe("FinalReportConsumer — exec callback", () => {
  it("runs the configured command with the report JSON on stdin", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-exec", repo_path: repoPath });
    const role = h.roles.create({ name: "worker-exec", persistent: false });
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "worker-exec-1",
    });
    const sessionId = "session-exec-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9001,
    });
    const sinkPath = join(repoPath, "exec-sink.json");
    h.workspaces.updateConfig(ws.id, {
      final_report_callback: {
        kind: "exec",
        command: "sh",
        args: ["-c", `cat > ${sinkPath}`],
      },
    });

    h.agentStatusLog.append({
      agent_id: agent.id,
      session_id: sessionId,
      kind: "final-report",
      state: "final",
      summary: "structured",
      details: { well: "alpha", badly: "beta" },
    });

    const result = await h.consumer.drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    expect(existsSync(sinkPath)).toBe(true);
    const payload = JSON.parse(readFileSync(sinkPath, "utf8")) as FinalReportPayload;
    expect(payload.workspace_id).toBe(ws.id);
    expect(payload.agent_id).toBe(agent.id);
    expect(payload.session_id).toBe(sessionId);
    expect(payload.kind).toBe("final-report");
    expect(payload.summary).toBe("structured");
    expect(payload.report).toMatchObject({ well: "alpha", badly: "beta" });

    teardown(h);
  });

  it("appends a callback-error row when the exec command exits non-zero", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-exec-fail", repo_path: repoPath });
    const role = h.roles.create({ name: "worker-exec-fail", persistent: false });
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "w",
    });
    const sessionId = "session-exec-fail-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9002,
    });
    h.workspaces.updateConfig(ws.id, {
      final_report_callback: {
        kind: "exec",
        command: "sh",
        args: ["-c", "echo nope >&2; exit 7"],
      },
    });

    h.agentStatusLog.append({
      agent_id: agent.id,
      session_id: sessionId,
      kind: "final-report",
      state: "final",
      summary: "failing",
      details: { well: "x" },
    });

    const result = await h.consumer.drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(1);

    const errs = callbackErrorsBySession(h, sessionId);
    expect(errs.length).toBe(1);
    expect(errs[0]!.kind).toBe("callback-error");
    expect(errs[0]!.agent_id).toBe(agent.id);
    expect(errs[0]!.session_id).toBe(sessionId);
    expect(errs[0]!.details).not.toBeNull();
    const details = errs[0]!.details as Record<string, unknown>;
    expect(details["callback_kind"]).toBe("exec");
    expect(typeof details["error"]).toBe("string");
    expect(String(details["error"])).toContain("7");

    // Cursor still advanced — we never want to spin on a poison message.
    expect(h.stateStore.getLastConsumedId(ws.id)).toBeGreaterThan(0);

    teardown(h);
  });
});

describe("FinalReportConsumer — http callback", () => {
  let captureServer: FastifyInstance;
  let captureUrl: string;
  let captured: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: FinalReportPayload;
    statusToReturn: number;
  }>;

  beforeEach(async () => {
    captured = [];
    captureServer = Fastify({ logger: false });
    captureServer.post("/hook", async (req, reply) => {
      const item = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: req.body as FinalReportPayload,
        statusToReturn: 200,
      };
      captured.push(item);
      reply.code(200);
      return { ok: true };
    });
    captureServer.post("/boom", async (_req, reply) => {
      reply.code(500);
      return { error: "synthetic failure" };
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

  it("POSTs the report JSON to the configured URL with custom headers", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-http", repo_path: repoPath });
    const role = h.roles.create({ name: "worker-http", persistent: false });
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "w",
    });
    const sessionId = "session-http-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9003,
    });
    h.workspaces.updateConfig(ws.id, {
      final_report_callback: {
        kind: "http",
        url: `${captureUrl}/hook`,
        headers: { "X-Clobber-Token": "abc123" },
      },
    });

    h.agentStatusLog.append({
      agent_id: agent.id,
      session_id: sessionId,
      kind: "final-report",
      state: "final",
      summary: "structured",
      details: { useful: "auto-file as ticket" },
    });

    const result = await h.consumer.drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(captured.length).toBe(1);
    expect(captured[0]!.headers["x-clobber-token"]).toBe("abc123");
    expect(captured[0]!.body.workspace_id).toBe(ws.id);
    expect(captured[0]!.body.session_id).toBe(sessionId);
    expect(captured[0]!.body.report).toMatchObject({ useful: "auto-file as ticket" });

    teardown(h);
  });

  it("appends a callback-error row when the http endpoint returns non-2xx", async () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-http-fail", repo_path: repoPath });
    const role = h.roles.create({ name: "worker-http-fail", persistent: false });
    const agent = h.agents.create({
      workspace_id: ws.id,
      role_id: role.id,
      label: "w",
    });
    const sessionId = "session-http-fail-0001";
    h.sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9004,
    });
    h.workspaces.updateConfig(ws.id, {
      final_report_callback: { kind: "http", url: `${captureUrl}/boom` },
    });

    h.agentStatusLog.append({
      agent_id: agent.id,
      session_id: sessionId,
      kind: "final-report",
      state: "final",
      summary: "structured",
      details: { well: "x" },
    });

    const result = await h.consumer.drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(1);
    const errs = callbackErrorsBySession(h, sessionId);
    expect(errs.length).toBe(1);
    const details = errs[0]!.details as Record<string, unknown>;
    expect(details["callback_kind"]).toBe("http");
    expect(String(details["error"])).toContain("500");

    teardown(h);
  });
});

describe("FinalReportConsumer — config defaults + schema", () => {
  it("a new workspace defaults to the noop callback", () => {
    const h = buildHarness();
    const ws = h.workspaces.create({ name: "ws-default", repo_path: repoPath });
    expect(ws.final_report_callback).toEqual({ ...DEFAULT_FINAL_REPORT_CALLBACK });
    expect(ws.final_report_callback.kind).toBe("noop");
    teardown(h);
  });

  it("accepts a custom final_report_callback on creation", () => {
    const h = buildHarness();
    const ws = h.workspaces.create({
      name: "ws-custom",
      repo_path: repoPath,
      final_report_callback: { kind: "noop" },
    });
    expect(ws.final_report_callback).toEqual({ kind: "noop" });
    teardown(h);
  });
});
