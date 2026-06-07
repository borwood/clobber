// #567 PR2 — per-agent scope override: 3-tier intersection real-path test.
//
// AC: a per-agent !roles.commit deny refuses commit while the role grants it;
// ws ∩ role ∩ agent intersection holds.

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
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { authorizeCommand } from "../src/routes/_agent-auth.ts";
import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly tokens: ReturnType<typeof createSessionTokenStore>;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly roles: ReturnType<typeof createRoleStore>;
  readonly roleVersions: ReturnType<typeof createRoleVersionStore>;
  readonly workspaces: ReturnType<typeof createWorkspaceStore>;
  readonly workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  readonly workspaceId: string;
  readonly managerToken: string;
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

  const ws = workspaces.create({ name: "3tier-ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const managerRole = roles.findInWorkspace(ws.id, "manager");
  if (managerRole === null) throw new Error("manager role not seeded");

  // Raise manager ceiling to 2 so the test can spawn a second manager to
  // exercise the 3rd tier (agent scope) — the caller session already counts as 1.
  workspaceRoles.setCeiling(ws.id, managerRole.id, 2);

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

  return { server, db, tokens, sessions, roles, roleVersions, workspaces, workspaceRoles, workspaceId: ws.id, managerToken };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("token-scope baking PR2 — 3-tier intersection (#567)", () => {
  it("per-agent !roles.commit deny refuses commit while role grants it; ws∩role∩agent holds", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-scope-pr2-"));
    const h = buildHarness(repoPath);
    try {
      // Spawn a second manager with a per-agent scope that denies roles.commit.
      // Manager has allowedCliCommands: ["*"] so the ROLE grants roles.commit.
      // The per-agent deny is what removes it — this exercises the 3rd tier.
      const spawnRes = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.managerToken),
        payload: {
          role: "manager",
          prompt: "go",
          label: "scope-test-manager",
          scope_override: { allow: ["*"], deny: ["!roles.commit"] },
        },
      });
      expect(spawnRes.statusCode).toBe(200);
      const { session_id: workerSessionId } = spawnRes.json() as { session_id: string };

      // The baked scope must exclude roles.commit because the 3rd tier (agent)
      // denies it, even though the role tier grants everything via "*".
      const workerScopeJson = h.tokens.scopeForSession(workerSessionId);
      expect(workerScopeJson).not.toBeNull();
      const workerScope = JSON.parse(workerScopeJson!) as { allow: string[]; deny: string[] };
      expect(workerScope.allow).not.toContain("roles.commit");

      // Verify authz directly via authorizeCommand using the baked scope.
      const workerSession = h.sessions.get(workerSessionId);
      expect(workerSession).not.toBeNull();
      const deps = { roles: h.roles, roleVersions: h.roleVersions, workspaces: h.workspaces };

      // roles.commit is in the deny list → 403.
      const denied = authorizeCommand(workerSession!, "roles.commit", deps, workerScopeJson);
      expect(denied.ok).toBe(false);
      expect((denied as { ok: false; status: number }).status).toBe(403);

      // whoami is not denied → allowed.
      const allowed = authorizeCommand(workerSession!, "whoami", deps, workerScopeJson);
      expect(allowed.ok).toBe(true);

      // roles.diff is also not denied → allowed (agent scope only excludes roles.commit).
      const diffAllowed = authorizeCommand(workerSession!, "roles.diff", deps, workerScopeJson);
      expect(diffAllowed.ok).toBe(true);
    } finally {
      await h.server.close();
      h.db.close();
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("effective scope surfaces in agents list via effective_scope field", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-scope-pr2-agents-"));
    const h = buildHarness(repoPath);
    try {
      // Spawn a worker with a restricted scope (tag:read only).
      // Worker's full allow-list is ["whoami","ask","status","report","reply"].
      // tag:read covers only "whoami" (read-tagged); the write-tagged verbs are
      // excluded. Baked scope = intersection = ["whoami"].
      const spawnRes = await h.server.inject({
        method: "POST",
        url: "/agent/spawn",
        headers: bearer(h.managerToken),
        payload: {
          role: "worker",
          prompt: "go",
          label: "scope-surf-worker",
          scope_override: { allow: ["tag:read"], deny: [] },
        },
      });
      expect(spawnRes.statusCode).toBe(200);
      const { session_id: workerSessionId } = spawnRes.json() as { session_id: string };

      // The agents list should include effective_scope for each live agent.
      const agentsRes = await h.server.inject({
        method: "GET",
        url: "/agent/agents",
        headers: bearer(h.managerToken),
      });
      expect(agentsRes.statusCode).toBe(200);
      const { agents } = agentsRes.json() as {
        agents: Array<{ session_id: string; effective_scope: { allow: string[] } | null }>;
      };

      // Find the spawned worker by session_id to avoid confusing it with the
      // caller (manager) whose effective_scope is null (no scope_override on mint).
      const workerEntry = agents.find((a) => a.session_id === workerSessionId);
      expect(workerEntry).toBeDefined();
      expect(workerEntry!.effective_scope).not.toBeNull();
      // Baked scope = ws∩role∩agent = {allow:["whoami"],deny:[]}.
      expect(workerEntry!.effective_scope!.allow).toContain("whoami");
      // write-tagged verbs are excluded by tag:read override.
      expect(workerEntry!.effective_scope!.allow).not.toContain("status");
      expect(workerEntry!.effective_scope!.allow).not.toContain("spawn");
    } finally {
      await h.server.close();
      h.db.close();
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
