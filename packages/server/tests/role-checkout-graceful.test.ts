import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #411 — `roles checkout` must degrade gracefully: a role whose DB pin and
// on-disk fork-repo are out of sync (the #412 disconnect's residual states) must
// surface a reasoned 4xx, never a bare 500/TypeError, and the route must log the
// thrown error so the failure is not a black box. The happy path stays green.

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

let roleRepoDir: string;

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 9800;
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
    db,
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
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
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    roleRepoDir,
  });
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function roleId(h: Harness, name: string, wsId: string): string {
  const row = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get(name, wsId) as { id: string } | null;
  if (row === null) throw new Error(`role ${name} not seeded`);
  return row.id;
}

async function createWorkspace(h: Harness, repoPath: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
  });
  if (res.statusCode !== 201) throw new Error(`create ws: ${res.body}`);
  return (res.json() as { id: string }).id;
}

async function spawnSession(h: Harness, wsId: string, id: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: id, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn: ${res.body}`);
  const sessionId = (res.json() as { session_id: string }).session_id;
  return h.tokens.mint(sessionId);
}

async function checkoutRaw(h: Harness, token: string, idOrName: string) {
  return h.server.inject({
    method: "POST",
    url: `/agent/roles/${encodeURIComponent(idOrName)}/checkout`,
    headers: { authorization: `Bearer ${token}` },
  });
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-role-checkout-graceful-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-role-checkout-graceful-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#411 roles checkout degrades to a reasoned 4xx, never a bare 500", () => {
  it("a resolvable role still checks out (happy path stays green)", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const token = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const res = await checkoutRaw(h, token, "worker");
    expect(res.statusCode, res.body).toBe(200);

    await teardown(h);
  });

  it("a pin that does not resolve in the fork-repo → 409 reasoned, not 500", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    // The DB pin points at a sha the on-disk fork-repo does not contain (repo
    // regenerated / pin minted elsewhere — the #412 disconnect's residual state).
    const bogus = "0".repeat(40);
    h.db.prepare("UPDATE roles SET current_commit_sha = ? WHERE id = ?").run(bogus, workerId);

    const res = await checkoutRaw(h, token, "worker");
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("worker");
    expect((res.json() as { error: string }).error).toContain("does not resolve");

    await teardown(h);
  });

  it("a role with no pin at all → 422 reasoned, not 500", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    // No commit pin and no version to lazily cut over from — ensureCommitPinned
    // can't repair this; it must surface, not TypeError.
    h.db
      .prepare(
        "UPDATE roles SET current_commit_sha = NULL, current_commit_branch = NULL WHERE id = ?",
      )
      .run(workerId);

    const res = await checkoutRaw(h, token, "worker");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain("worker");

    await teardown(h);
  });

  it("the underlying error is logged server-side when a checkout degrades", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const token = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const bogus = "0".repeat(40);
    h.db.prepare("UPDATE roles SET current_commit_sha = ? WHERE id = ?").run(bogus, workerId);

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await checkoutRaw(h, token, "worker");
      expect(res.statusCode).toBe(409);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }

    await teardown(h);
  });
});
