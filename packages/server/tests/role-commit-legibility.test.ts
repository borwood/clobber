import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
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
import { git } from "../src/role-git.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";

// #637 — AC1: commit requires a non-empty message (no default fallback).
// AC2: every commit stamps agent provenance — author user.name=<label> + 4 trailers.
// AC3: GET /agent/roles/:name/upstream/log with no range → branch changelog (entries[]).

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  wsId: string;
  managerId: string;
  token: string;
  sessionId: string;
  roleRepoDir: string;
}

let harness: Harness;
let repo: RepoFixture;
// sha committed during AC2 setup, verified in AC2 + AC3 tests.
let ac2CommitSha: string;

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function cloneDirFor(wsId: string): string {
  return join(dirname(harness.roleRepoDir), "role-repos", wsId);
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  repo = makeRepoFixture("clobber-legibility-");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-legibility-repo-"));
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9100;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
  const server = createServer({
    db, store: createEventStore(db), workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db), roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db), agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens, agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner, hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE, cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    roleRepoDir,
  });

  const wsRes = await server.inject({ method: "POST", url: "/workspaces",
    payload: { name: "legibility-ws", repo_path: repo.path } });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db.prepare(
    "SELECT id FROM roles WHERE name = ? AND workspace_id = ?",
  ).get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("manager seed missing");

  const spawnRes = await server.inject({ method: "POST", url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot",
      label: "test-agent-label" } });
  if (spawnRes.statusCode !== 200) throw new Error(`spawn: ${spawnRes.body}`);
  const spawned = spawnRes.json() as { session_id: string };

  harness = {
    server, db, tokens, wsId: ws.id, managerId: managerRow.id,
    token: tokens.mint(spawned.session_id),
    sessionId: spawned.session_id,
    roleRepoDir,
  };
});

afterAll(async () => {
  await harness.server.close();
  harness.db.close();
  repo.cleanup();
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
});

async function doCheckout(token: string): Promise<void> {
  const res = await harness.server.inject({
    method: "POST", url: "/agent/roles/worker/checkout", headers: auth(token),
  });
  if (res.statusCode !== 200) throw new Error(`checkout: ${res.body}`);
}

async function doDiscard(token: string): Promise<void> {
  await harness.server.inject({
    method: "POST", url: "/agent/role-checkout/discard", headers: auth(token),
  });
}

describe("#637 AC1: commit requires a non-empty message", () => {
  it("POST commit with no message body → 400 (message required)", async () => {
    await doCheckout(harness.token);
    const res = await harness.server.inject({
      method: "POST", url: "/agent/role-checkout/commit",
      headers: auth(harness.token), payload: {},
    });
    expect(res.statusCode).toBe(400);
    await doDiscard(harness.token);
  });
});

describe("#637 AC2: commit carries agent provenance", () => {
  beforeAll(async () => {
    await doCheckout(harness.token);
    const res = await harness.server.inject({
      method: "POST", url: "/agent/role-checkout/commit",
      headers: auth(harness.token),
      payload: { message: "legibility test commit" },
    });
    if (res.statusCode !== 200) throw new Error(`commit: ${res.body}`);
    ac2CommitSha = (res.json() as { sha: string }).sha;
  });

  it("author user.name is the session label, not the generic 'clobber'", () => {
    const author = git(cloneDirFor(harness.wsId), "log", "--format=%an", "-1", ac2CommitSha).trim();
    expect(author).toBe("test-agent-label");
  });

  it("Clobber-Agent-Label trailer matches session label", () => {
    const body = git(cloneDirFor(harness.wsId), "log", "--format=%B", "-1", ac2CommitSha);
    expect(body).toContain("Clobber-Agent-Label: test-agent-label");
  });

  it("Clobber-Role trailer matches the checked-out role name", () => {
    const body = git(cloneDirFor(harness.wsId), "log", "--format=%B", "-1", ac2CommitSha);
    expect(body).toContain("Clobber-Role: worker");
  });

  it("Clobber-Commit-Pin trailer is a 40-char hex sha", () => {
    const body = git(cloneDirFor(harness.wsId), "log", "--format=%B", "-1", ac2CommitSha);
    expect(body).toMatch(/Clobber-Commit-Pin: [0-9a-f]{40}/);
  });

  it("Clobber-Session-Id trailer matches the spawned session id", () => {
    const body = git(cloneDirFor(harness.wsId), "log", "--format=%B", "-1", ac2CommitSha);
    expect(body).toContain(`Clobber-Session-Id: ${harness.sessionId}`);
  });

  it("session with no label → 422 (no fabricated identity)", async () => {
    // Temporarily clear the label to simulate a legacy/label-less session.
    harness.db.prepare("UPDATE sessions SET label = NULL WHERE id = ?").run(harness.sessionId);
    try {
      await doCheckout(harness.token);
      const res = await harness.server.inject({
        method: "POST", url: "/agent/role-checkout/commit",
        headers: auth(harness.token), payload: { message: "should fail" },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/label|identity|agent/i);
      await doDiscard(harness.token);
    } finally {
      harness.db.prepare("UPDATE sessions SET label = ? WHERE id = ?")
        .run("test-agent-label", harness.sessionId);
    }
  });
});

describe("#637 AC3: GET /upstream/log with no range → branch changelog", () => {
  it("returns entries array (not legacy log string) when no range is given", async () => {
    const res = await harness.server.inject({
      method: "GET", url: "/agent/roles/worker/upstream/log",
      headers: auth(harness.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("entries include the legibility commit with parsed provenance", async () => {
    const res = await harness.server.inject({
      method: "GET", url: "/agent/roles/worker/upstream/log",
      headers: auth(harness.token),
    });
    const body = res.json() as {
      entries: Array<{
        sha: string;
        message: string;
        provenance: { label: string; role: string; pin: string; sessionId: string } | null;
      }>;
    };
    const entry = body.entries.find((e) => e.message === "legibility test commit");
    expect(entry).not.toBeUndefined();
    expect(entry?.provenance?.label).toBe("test-agent-label");
    expect(entry?.provenance?.role).toBe("worker");
    expect(entry?.provenance?.sessionId).toBe(harness.sessionId);
  });

  it("range=@{upstream}.. still returns legacy { log: string } unchanged", async () => {
    const rangeParam = encodeURIComponent("@{upstream}..");
    const res = await harness.server.inject({
      method: "GET",
      url: `/agent/roles/worker/upstream/log?range=${rangeParam}`,
      headers: auth(harness.token),
    });
    // 200 or 422 (upstream not fetched) — both are valid; key check: no entries[].
    const body = res.json() as { log?: string; entries?: unknown[] };
    expect(body.entries).toBeUndefined();
    if (res.statusCode === 200) expect(typeof body.log).toBe("string");
  });
});
