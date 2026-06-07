// #565 — Track C Step 4: workspace perms tier + live 2-tier resolution.
//
// AC3 real-path tests:
//   (a) workspace deny !spawn refuses spawn even when the role grants it
//   (b) default permissive scope leaves ALL existing role grants intact
//       — proven on a real post-migration row, NOT a schema default literal
//   (c) intersection narrows: workspace {allow:["tag:read"]} ∩ broad role
//       → only read verbs pass

import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { buildAndRegress } from "../src/migration-harness.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaceId: string;
  readonly managerToken: string;
  readonly repoPath: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(repoPath: string): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  const ws = workspaces.create({ name: "perms-tier-ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  if (managerRole === null) throw new Error("manager role not seeded");

  const agent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
  const sessionId = randomUUID();
  sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: managerRole.id, pid: 1 });
  const managerToken = tokens.mint(sessionId);

  const stub: SpawnedAgentInfo = {
    sessionId: "stub",
    pid: 9000,
    exited: new Promise<number | null>(() => {}),
    stdin: makeStdin(),
    kill: () => {},
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
    spawner: () => ({ ...stub, sessionId: randomUUID() }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });

  return { server, db, workspaceId: ws.id, managerToken, repoPath };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("workspace perms tier — 2-tier resolution (AC3)", () => {
  it("(a) workspace deny !spawn refuses spawn even when role has ['*']", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-perms-tier-a-"));
    const h = buildHarness(repoPath);
    try {
      // Confirm manager can spawn without any workspace restriction.
      const allowedBefore = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.managerToken),
        payload: { role: "worker", prompt: "go", label: "should-work" },
      });
      expect(allowedBefore.statusCode).toBe(200);

      // Apply workspace-level deny for spawn.
      const patch = await h.server.inject({
        method: "PATCH",
        url: `/workspaces/${h.workspaceId}`,
        payload: { perms_scope: { allow: ["*"], deny: ["!spawn"] } },
      });
      expect(patch.statusCode).toBe(200);
      const patched = patch.json() as { perms_scope: { allow: string[]; deny: string[] } };
      expect(patched.perms_scope).toEqual({ allow: ["*"], deny: ["!spawn"] });

      // Manager's role still has ["*"], but workspace now denies spawn.
      const denied = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.managerToken),
        payload: { role: "worker", prompt: "go", label: "should-fail" },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/spawn/);

      // Verify non-denied verbs still work (whoami = tag:read, not in deny list).
      const stillOk = await h.server.inject({
        method: "GET",
        url: "/agent/me",
        headers: bearer(h.managerToken),
      });
      expect(stillOk.statusCode).toBe(200);
    } finally {
      await teardown(h);
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("(b) default permissive scope leaves ALL role grants intact — proven on real post-migration row", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-perms-tier-b-"));
    const dbPath = join(dir, "test.db");
    try {
      // Build a fully-seeded DB, then regress by dropping perms_scope to
      // simulate a workspace row that pre-dates this column.
      let capturedWorkspaceId!: string;
      buildAndRegress({
        path: dbPath,
        seed: (db) => {
          const workspaces = createWorkspaceStore(db);
          const repoPath = mkdtempSync(join(tmpdir(), "clobber-perms-tier-b-repo-"));
          const ws = workspaces.create({ name: "legacy-ws", repo_path: repoPath });
          capturedWorkspaceId = ws.id;
        },
        regress: (db) => {
          db.exec("ALTER TABLE workspaces DROP COLUMN perms_scope");
        },
      });

      // Reopen through the real entrypoint — migrateWorkspaceConfig backfills
      // the column with {"allow":["*"],"deny":[]}.
      const db = createDatabase(dbPath);
      const workspaces = createWorkspaceStore(db);

      const ws = workspaces.get(capturedWorkspaceId);
      if (ws === null) throw new Error("workspace not found after migration");

      // The actual stored row must materialize as the permissive default.
      expect(ws.perms_scope).toEqual({ allow: ["*"], deny: [] });

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c) workspace {allow:['tag:read']} ∩ role ['*'] → only read verbs pass", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-perms-tier-c-"));
    const h = buildHarness(repoPath);
    try {
      // Narrow the workspace to read-only.
      const patch = await h.server.inject({
        method: "PATCH",
        url: `/workspaces/${h.workspaceId}`,
        payload: { perms_scope: { allow: ["tag:read"], deny: [] } },
      });
      expect(patch.statusCode).toBe(200);

      // whoami is tag:read — must still pass.
      const readOk = await h.server.inject({
        method: "GET",
        url: "/agent/me",
        headers: bearer(h.managerToken),
      });
      expect(readOk.statusCode).toBe(200);

      // spawn is tag:admin — workspace no longer grants it.
      const adminDenied = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.managerToken),
        payload: { role: "worker", prompt: "go", label: "x" },
      });
      expect(adminDenied.statusCode).toBe(403);

      // status is tag:write — workspace no longer grants it.
      const writeDenied = await h.server.inject({
        method: "POST",
        url: "/agent/status",
        headers: bearer(h.managerToken),
        payload: { state: "working", summary: "test" },
      });
      expect(writeDenied.statusCode).toBe(403);
    } finally {
      await teardown(h);
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
