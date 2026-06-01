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
  let pidCounter = 9700;
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
    apiBase: "http://test.invalid",
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
  repo = makeRepoFixture("clobber-webhook-triggers-");
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
  managerAgentId: string;
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
  if (managerRow === null) throw new Error("seed missing manager");

  const bootRes = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string; agent_id: string };
  const token = h.tokens.mint(boot.session_id);
  return {
    workspaceId: ws.id,
    managerToken: token,
    managerRoleId: managerRow.id,
    managerAgentId: boot.agent_id,
  };
}

describe("POST /webhook-triggers — fire webhook trigger", () => {
  it("fires registered webhook trigger and returns dispatched count", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    // Set a webhook trigger on the manager role
    const patchRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.managerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { triggers: [{ kind: "webhook", path: "/hooks/x" }] },
    });
    expect(patchRes.statusCode).toBe(200);

    const fireRes = await h.server.inject({
      method: "POST",
      url: "/webhook-triggers",
      payload: { path: "/hooks/x", payload: { sample: 1 } },
    });
    expect(fireRes.statusCode).toBe(200);
    const body = fireRes.json() as { dispatched: number };
    expect(body.dispatched).toBe(1);

    await teardown(h);
  });

  it("returns dispatched=0 when no agent has a webhook trigger at that path", async () => {
    const h = buildHarness();
    await bootInWorkspace(h, repo.path);

    const fireRes = await h.server.inject({
      method: "POST",
      url: "/webhook-triggers",
      payload: { path: "/hooks/nope" },
    });
    expect(fireRes.statusCode).toBe(200);
    const body = fireRes.json() as { dispatched: number };
    expect(body.dispatched).toBe(0);

    await teardown(h);
  });

  it("rejects body without a path with 400", async () => {
    const h = buildHarness();
    await bootInWorkspace(h, repo.path);

    const fireRes = await h.server.inject({
      method: "POST",
      url: "/webhook-triggers",
      payload: {},
    });
    expect(fireRes.statusCode).toBe(400);

    await teardown(h);
  });

  it("rejects body whose path does not start with / with 400", async () => {
    const h = buildHarness();
    await bootInWorkspace(h, repo.path);

    const fireRes = await h.server.inject({
      method: "POST",
      url: "/webhook-triggers",
      payload: { path: "hooks/x" },
    });
    expect(fireRes.statusCode).toBe(400);

    await teardown(h);
  });
});
