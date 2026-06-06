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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../src/server.ts";

function liveStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  calls: AgentSpawnRequest[];
}

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  const calls: AgentSpawnRequest[] = [];
  let counter = 0;
  const spawner: AgentSpawner = (req) => {
    calls.push(req);
    counter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9000 + counter,
      exited: new Promise<number | null>(() => {}),
      stdin: liveStdin(),
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
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    roleRepoDir,
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, tokens, calls };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;
let roleRepoDir: string;
beforeEach(() => {
  repo = makeRepoFixture("clobber-spawn-version-tools-");
  roleRepoDir = _mkdtempSync(_joinPath(_tmpdir(), "clobber-rolerepo-"));
});
afterEach(() => {
  repo.cleanup();
  _rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("spawn sources allowedTools from current role version, not roles row", () => {
  it("after editing the worker's allowed_tools, the next spawn carries the new list", async () => {
    const h = buildHarness();

    const wsRes = await h.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repo.path },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };

    const workerRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("worker", ws.id) as { id: string };

    // Boot the manager so we have a token authorised to PATCH workspace roles.
    const managerRow = h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    const bootRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: managerRow.id,
        prompt: "boot",
        label: "boot",
      },
    });
    expect(bootRes.statusCode).toBe(200);
    const boot = bootRes.json() as { session_id: string };
    const managerToken = h.tokens.mint(boot.session_id);

    // Edit the worker role's allowed_tools — bumps role_versions but leaves the
    // legacy roles.allowed_tools column untouched.
    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${workerRow.id}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { allowed_tools: ["OnlyOne"] },
    });
    expect(editRes.statusCode).toBe(200);

    // Spawn the worker — the spawned RuntimeSpawnOptions.allowedTools must match
    // the post-edit version, not the seed-time roles.allowed_tools column.
    h.calls.length = 0;
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: ws.id,
        role_id: workerRow.id,
        prompt: "go",
        label: "w1",
      },
    });
    expect(spawnRes.statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.allowedTools).toEqual(["OnlyOne"]);

    await teardown(h);
  });
});
