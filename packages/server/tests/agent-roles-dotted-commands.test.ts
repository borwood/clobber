// #551 — AC2 + AC3 tests.
// AC2: pin the no-implicit-prefix-grant matching rule for isCliCommandAllowed.
// AC3: real-path authz tests — POST each newly-dotted route, assert 403 when the
//      action is absent from a non-wildcard allow-list (#522 bar).
//
// New commandNames verified here:
//   roles.prompt-modules.add   POST /agent/roles/:id/prompt-modules
//   roles.prompt-modules.toggle PATCH /agent/roles/:id/prompt-modules/:name
//   roles.wake-programs.add    POST /agent/roles/:id/wake-programs
//   roles.wake-programs.edit   PATCH /agent/roles/:id/wake-programs/:name
//   roles.wake-programs.remove DELETE /agent/roles/:id/wake-programs/:name
//   prompt-modules.edit        PUT /agent/prompt-modules/:name  (AC4)

import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { isCliCommandAllowed } from "@clobber/shared";
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
import { ensureUpstreamRoleRepo } from "../src/role-repo.ts";
import type { SpawnedAgentInfo } from "../src/types.ts";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly workspaceId: string;
  // manager has ["*"] allow-list — passes every auth gate.
  readonly managerToken: string;
  // worker has ["whoami","ask","status","report","reply"] — no prompt-modules/wake-programs verbs.
  readonly workerToken: string;
  // prefix-only has ["roles"] — used to pin the no-implicit-prefix-grant rule (AC2).
  readonly prefixOnlyToken: string;
  readonly repoPath: string;
  readonly roleRepoDir: string;
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

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-dotted-cmd-"));
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-dotted-cmd-repo-"));
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });

  const upstream = ensureUpstreamRoleRepo(roleRepoDir);
  seedWorkspaceRoles(db, ws.id, upstream.forks);

  const managerRole = roles.findInWorkspace(ws.id, "manager");
  if (managerRole === null) throw new Error("manager role not seeded");
  const workerRole = roles.findInWorkspace(ws.id, "worker");
  if (workerRole === null) throw new Error("worker role not seeded");

  // Create a role with only ["roles"] in its allow-list to pin the AC2 rule.
  // Inserted directly because createRoleStore.create does not accept workspace_id.
  const prefixRoleId = randomUUID();
  const prefixVersionId = randomUUID();
  db.prepare(
    `INSERT INTO roles (id, name, persistent, workspace_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(prefixRoleId, "prefix-only", 0, ws.id, Date.now());
  db.prepare(
    `INSERT INTO role_versions
       (id, role_id, version, framing, system_prompt, skills_json,
        allowed_tools_json, allowed_cli_commands_json, hooks_json,
        triggers_json, seed_refs_json, wake_programs_json,
        default_wake_program, contract_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    prefixVersionId, prefixRoleId, 1, "", "prefix-only test role", "[]",
    "[]", JSON.stringify(["roles"]), "[]", "[]", "[]", "[]",
    null, ENGINE_CONTRACT_VERSION, Date.now(),
  );

  function mintToken(roleId: string): string {
    const agent = agents.create({ workspace_id: ws.id, role_id: roleId });
    const sessionId = randomUUID();
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleId,
      pid: 1,
    });
    return tokens.mint(sessionId);
  }

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
    roleRepoDir,
  });

  return {
    server,
    db,
    workspaceId: ws.id,
    managerToken: mintToken(managerRole.id),
    workerToken: mintToken(workerRole.id),
    prefixOnlyToken: mintToken(prefixRoleId),
    repoPath,
    roleRepoDir,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
  rmSync(h.repoPath, { recursive: true, force: true });
  rmSync(h.roleRepoDir, { recursive: true, force: true });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

// AC2 — pin the no-implicit-prefix-grant matching rule as a unit test so a
// future refactor cannot silently flip the semantics. Explicit-only: a grant of
// "roles" or "roles.prompt-modules" must NOT imply any dotted sub-verb.
describe("isCliCommandAllowed — no-implicit-prefix-grant rule (AC2 pin)", () => {
  it("'roles' does not grant 'roles.prompt-modules.add'", () => {
    expect(isCliCommandAllowed(["roles"], "roles.prompt-modules.add")).toBe(false);
  });

  it("'roles' does not grant 'roles.prompt-modules.toggle'", () => {
    expect(isCliCommandAllowed(["roles"], "roles.prompt-modules.toggle")).toBe(false);
  });

  it("'roles' does not grant 'roles.wake-programs.add'", () => {
    expect(isCliCommandAllowed(["roles"], "roles.wake-programs.add")).toBe(false);
  });

  it("'roles' does not grant 'roles.wake-programs.edit'", () => {
    expect(isCliCommandAllowed(["roles"], "roles.wake-programs.edit")).toBe(false);
  });

  it("'roles' does not grant 'roles.wake-programs.remove'", () => {
    expect(isCliCommandAllowed(["roles"], "roles.wake-programs.remove")).toBe(false);
  });

  it("'roles.prompt-modules' does not grant 'roles.prompt-modules.add'", () => {
    expect(isCliCommandAllowed(["roles.prompt-modules"], "roles.prompt-modules.add")).toBe(false);
  });

  it("'*' grants any dotted verb including new prompt-module and wake-program verbs", () => {
    expect(isCliCommandAllowed(["*"], "roles.prompt-modules.add")).toBe(true);
    expect(isCliCommandAllowed(["*"], "roles.prompt-modules.toggle")).toBe(true);
    expect(isCliCommandAllowed(["*"], "roles.wake-programs.add")).toBe(true);
    expect(isCliCommandAllowed(["*"], "roles.wake-programs.edit")).toBe(true);
    expect(isCliCommandAllowed(["*"], "roles.wake-programs.remove")).toBe(true);
    expect(isCliCommandAllowed(["*"], "prompt-modules.edit")).toBe(true);
  });

  it("exact dotted match grants only that verb, not siblings", () => {
    expect(isCliCommandAllowed(["roles.prompt-modules.add"], "roles.prompt-modules.add")).toBe(true);
    expect(isCliCommandAllowed(["roles.prompt-modules.add"], "roles.prompt-modules.toggle")).toBe(false);
    expect(isCliCommandAllowed(["roles.prompt-modules.add"], "roles.wake-programs.add")).toBe(false);
  });
});

// AC3 — real-path authz tests. Worker allow-list = ["whoami","ask","status",
// "report","reply"] — it excludes every new verb, so 403 is the expected response.
// Before implementation, routes don't exist → 404, causing these tests to FAIL.
// After implementation, routes exist and enforce auth → 403 for worker.
describe("real-path authz — newly dotted role-mutation verbs (AC3)", () => {
  it("POST /agent/roles/:id/prompt-modules — 403 worker; passes auth for manager", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/prompt-modules",
        headers: bearer(h.workerToken),
        payload: { name: "repo-sdlc" },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/roles\.prompt-modules\.add/);

      const allowed = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/prompt-modules",
        headers: bearer(h.managerToken),
        payload: { name: "repo-sdlc" },
      });
      expect(allowed.statusCode).not.toBe(403);
      expect(allowed.statusCode).not.toBe(401);
    } finally {
      await teardown(h);
    }
  });

  it("PATCH /agent/roles/:id/prompt-modules/:name — 403 worker", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "PATCH",
        url: "/agent/roles/manager/prompt-modules/repo-sdlc",
        headers: bearer(h.workerToken),
        payload: { enabled: false },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/roles\.prompt-modules\.toggle/);
    } finally {
      await teardown(h);
    }
  });

  it("POST /agent/roles/:id/wake-programs — 403 worker", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/wake-programs",
        headers: bearer(h.workerToken),
        payload: { name: "triage", system: "sys text", user: "kick text" },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/roles\.wake-programs\.add/);
    } finally {
      await teardown(h);
    }
  });

  it("PATCH /agent/roles/:id/wake-programs/:name — 403 worker", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "PATCH",
        url: "/agent/roles/manager/wake-programs/task",
        headers: bearer(h.workerToken),
        payload: { system: "new system" },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/roles\.wake-programs\.edit/);
    } finally {
      await teardown(h);
    }
  });

  it("DELETE /agent/roles/:id/wake-programs/:name — 403 worker", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "DELETE",
        url: "/agent/roles/manager/wake-programs/task",
        headers: bearer(h.workerToken),
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/roles\.wake-programs\.remove/);
    } finally {
      await teardown(h);
    }
  });

  it("PUT /agent/prompt-modules/:name — 403 worker (AC4 route)", async () => {
    const h = buildHarness();
    try {
      const denied = await h.server.inject({
        method: "PUT",
        url: "/agent/prompt-modules/repo-sdlc",
        headers: bearer(h.workerToken),
        payload: { definition: { kind: "static", text: "# test" } },
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json() as { error: string };
      expect(body.error).toMatch(/prompt-modules\.edit/);
    } finally {
      await teardown(h);
    }
  });
});

// AC2 real-path confirmation: a role with only ["roles"] in its allow-list must
// be denied every prompt-module and wake-program write verb at the server level.
describe("real-path no-implicit-prefix-grant — ['roles'] allow-list (AC2 + AC3)", () => {
  it("['roles'] is refused for roles.prompt-modules.add", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/prompt-modules",
        headers: bearer(h.prefixOnlyToken),
        payload: { name: "repo-sdlc" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await teardown(h);
    }
  });

  it("['roles'] is refused for roles.wake-programs.add", async () => {
    const h = buildHarness();
    try {
      const res = await h.server.inject({
        method: "POST",
        url: "/agent/roles/manager/wake-programs",
        headers: bearer(h.prefixOnlyToken),
        payload: { name: "p", system: "s", user: "u" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await teardown(h);
    }
  });
});
