import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync as _mkdtempSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _joinPath } from "node:path";
import { PassThrough } from "node:stream";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  let pidCounter = 9500;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
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
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    roleRepoDir,
  
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;
let roleRepoDir: string;

beforeEach(() => {
  repo = makeRepoFixture("clobber-roles-triggers-");
  roleRepoDir = _mkdtempSync(_joinPath(_tmpdir(), "clobber-rolerepo-"));
});

afterEach(() => {
  repo.cleanup();
  _rmSync(roleRepoDir, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerRoleId: string;
  workerRoleId: string;
}

async function bootInWorkspace(h: Harness, repoPath: string): Promise<Booted> {
  const wsRes = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  const workerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string } | null;
  if (managerRow === null || workerRow === null) {
    throw new Error("seed missing manager/worker");
  }

  const bootRes = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const token = h.tokens.mint(boot.session_id);
  return {
    workspaceId: ws.id,
    managerToken: token,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
  };
}

describe("PATCH /agent/roles/:idOrName — triggers", () => {
  it("PATCH triggers on a persistent role advances the pin and persists triggers", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const triggers = [
      { kind: "cron", expr: "0 9 * * *" },
      { kind: "issue-assigned", repo: "owner/name" },
    ];
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { branch: string; sha: string; no_new_version: boolean };
    expect(body.no_new_version).toBe(true);
    expect(body.sha.length).toBeGreaterThan(0);

    const showRes = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(showRes.statusCode).toBe(200);
    const detail = showRes.json() as {
      current_version: { triggers: unknown };
    };
    expect(detail.current_version.triggers).toEqual(triggers);

    await teardown(h);
  });

  it("PATCH triggers on an ephemeral role returns 422", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers: [{ kind: "cron", expr: "0 9 * * *" }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/persistent/i);

    await teardown(h);
  });

  it("PATCH triggers: [] on an ephemeral role is allowed (clearing triggers is a no-op)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers: [] },
    });
    expect(res.statusCode).toBe(200);

    await teardown(h);
  });

  it("PATCH with malformed trigger returns 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers: [{ kind: "smoke-signal", channel: "1" }] },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("editing system_prompt does not clobber existing triggers (carry-over)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const triggers = [{ kind: "cron", expr: "*/5 * * * *" }];
    const setRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers },
    });
    expect(setRes.statusCode).toBe(200);

    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "new prompt" },
    });
    expect(editRes.statusCode).toBe(200);

    const showRes = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const detail = showRes.json() as {
      current_version: { triggers: unknown; system_prompt: string };
    };
    // Editing system_prompt carries the existing triggers over (no field loss).
    expect(detail.current_version.triggers).toEqual(triggers);
    expect(detail.current_version.system_prompt).toBe("new prompt");

    await teardown(h);
  });

  it("a role created from seed has triggers: [] in its detail response", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    // The worker ships no default triggers (only the manager declares one,
    // #685 bootstrap-interview) — this proves the generic seed→detail
    // round-trip, not anything manager-specific.
    const showRes = await h.server.inject({
      method: "GET",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const detail = showRes.json() as {
      current_version: { triggers: unknown };
    };
    expect(detail.current_version.triggers).toEqual([]);

    await teardown(h);
  });
});
