import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
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
import type { RoleSkill, ManagerSkillPolicy } from "@clobber/shared";

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

beforeEach(() => {
  repo = makeRepoFixture("clobber-self-skills-");
});

afterEach(() => {
  repo.cleanup();
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerSessionId: string;
  managerAgentId: string;
  managerRoleId: string;
  workerToken: string;
  workerSessionId: string;
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

  const managerBoot = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: managerRow.id,
      prompt: "boot manager",
      label: "boot",
    },
  });
  if (managerBoot.statusCode !== 200) throw new Error(`mgr boot: ${managerBoot.body}`);
  const mgrBody = managerBoot.json() as { session_id: string; agent_id: string };

  const workerBoot = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: workerRow.id,
      prompt: "boot worker",
      label: "boot",
    },
  });
  if (workerBoot.statusCode !== 200) throw new Error(`wkr boot: ${workerBoot.body}`);
  const wkrBody = workerBoot.json() as { session_id: string };

  return {
    workspaceId: ws.id,
    managerToken: h.tokens.mint(mgrBody.session_id),
    managerSessionId: mgrBody.session_id,
    managerAgentId: mgrBody.agent_id,
    managerRoleId: managerRow.id,
    workerToken: h.tokens.mint(wkrBody.session_id),
    workerSessionId: wkrBody.session_id,
    workerRoleId: workerRow.id,
  };
}

function writeCatalogSkill(repoPath: string, name: string, body: string): void {
  const dir = join(repoPath, ".clobber", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

async function setPolicy(
  h: Harness,
  workspaceId: string,
  policy: ManagerSkillPolicy,
): Promise<void> {
  const res = await h.server.inject({
    method: "PATCH",
    url: `/workspaces/${workspaceId}`,
    payload: { manager_skill_policy: policy },
  });
  if (res.statusCode !== 200) throw new Error(`set policy: ${res.body}`);
}

interface SelfSkillsResponse {
  readonly policy: ManagerSkillPolicy;
  readonly granted: readonly RoleSkill[];
  readonly catalog: readonly RoleSkill[];
}

function readSkillsJson(h: Harness, roleId: string): RoleSkill[] {
  const row = h.db
    .prepare(
      `SELECT v.skills_json AS skills_json
       FROM role_versions v
       JOIN roles r ON r.current_version_id = v.id
       WHERE r.id = ?`,
    )
    .get(roleId) as { skills_json: string } | null;
  if (row === null) throw new Error(`no current version for ${roleId}`);
  return JSON.parse(row.skills_json) as RoleSkill[];
}

interface SkillSelfGrantLogRow {
  state: string;
  summary: string;
  details_json: string;
}

function readSelfGrantLog(
  h: Harness,
  sessionId: string,
): SkillSelfGrantLogRow[] {
  return h.db
    .prepare(
      `SELECT state, summary, details_json
       FROM agent_status_log
       WHERE session_id = ? AND kind = 'skill-self-grant'
       ORDER BY id ASC`,
    )
    .all(sessionId) as SkillSelfGrantLogRow[];
}

describe("GET /agent/self-skills — discovery", () => {
  it("returns the workspace policy + granted skills + filesystem-scanned catalog", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "# /clobber-pm\nworkspace skill body");
    writeCatalogSkill(repo.path, "audit-tickets", "# /audit-tickets\nfiler");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SelfSkillsResponse;
    expect(body.policy).toEqual({
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    const catalogNames = body.catalog.map((s) => s.name).sort();
    expect(catalogNames).toEqual(["audit-tickets", "clobber-pm"]);
    const pm = body.catalog.find((s) => s.name === "clobber-pm");
    expect(pm?.body).toContain("workspace skill body");

    // Granted starts as whatever the manager role was seeded with.
    expect(Array.isArray(body.granted)).toBe(true);

    await teardown(h);
  });

  it("returns an empty catalog when the workspace has no skills directory", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SelfSkillsResponse;
    expect(body.catalog).toEqual([]);
    expect(body.policy).toEqual({ allow_self_grant: false, allowed_skills: [] });
    await teardown(h);
  });

  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("returns 403 when called by a non-persistent role (worker)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    await teardown(h);
  });
});

describe("POST /agent/self-skills — granting", () => {
  it("default policy (allow_self_grant=false) rejects with 403, role version unchanged", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    const before = readSkillsJson(h, boot.managerRoleId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/self.grant/);

    const after = readSkillsJson(h, boot.managerRoleId);
    expect(after).toEqual(before);
    expect(readSelfGrantLog(h, boot.managerSessionId)).toEqual([]);
    await teardown(h);
  });

  it("rejects with 403 when allow_self_grant=true but skill not in allowed_skills", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    writeCatalogSkill(repo.path, "audit-tickets", "body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["audit-tickets"],
    });

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/allowed_skills/);
    await teardown(h);
  });

  it("rejects with 404 when the skill is allowed but missing from the workspace catalog", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    // Note: no writeCatalogSkill call → the SKILL.md file does not exist.

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/catalog/);
    await teardown(h);
  });

  it("grants a catalog skill: bumps role version, appends the skill, fires audit row", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "# /clobber-pm\nworkspace skill body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    const beforeRow = h.db
      .prepare(
        `SELECT v.version FROM role_versions v
         JOIN roles r ON r.current_version_id = v.id WHERE r.id = ?`,
      )
      .get(boot.managerRoleId) as { version: number };
    const before = readSkillsJson(h, boot.managerRoleId);

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      version: number;
      granted: RoleSkill[];
    };
    expect(body.role_id).toBe(boot.managerRoleId);
    expect(body.version).toBe(beforeRow.version + 1);
    expect(body.granted.map((s) => s.name)).toContain("clobber-pm");

    const after = readSkillsJson(h, boot.managerRoleId);
    expect(after.length).toBe(before.length + 1);
    const added = after.find((s) => s.name === "clobber-pm");
    expect(added?.body).toContain("workspace skill body");

    const log = readSelfGrantLog(h, boot.managerSessionId);
    expect(log.length).toBe(1);
    expect(log[0]!.state).toBe("granted");
    expect(log[0]!.summary).toContain("clobber-pm");
    const details = JSON.parse(log[0]!.details_json) as {
      action: string;
      skill: string;
      role_id: string;
      before: string[];
      after: string[];
    };
    expect(details.action).toBe("grant");
    expect(details.skill).toBe("clobber-pm");
    expect(details.role_id).toBe(boot.managerRoleId);
    expect(details.before).toEqual(before.map((s) => s.name));
    expect(details.after).toEqual(after.map((s) => s.name));

    await teardown(h);
  });

  it("rejects with 409 when the skill is already granted", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    const grantOnce = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(grantOnce.statusCode).toBe(200);

    const grantTwice = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(grantTwice.statusCode).toBe(409);
    await teardown(h);
  });

  it("rejects with 403 when called by a non-persistent role (worker)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });

    const res = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.workerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(res.statusCode).toBe(403);
    await teardown(h);
  });

  it("rejects with 400 when name is missing or empty", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["x"],
    });

    const empty = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "" },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    await teardown(h);
  });
});

describe("DELETE /agent/self-skills/:name — releasing", () => {
  it("removes a previously-granted skill: bumps role version, fires audit row", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    const grantRes = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(grantRes.statusCode).toBe(200);
    const grantedVersion = (grantRes.json() as { version: number }).version;
    const afterGrant = readSkillsJson(h, boot.managerRoleId);

    const releaseRes = await h.server.inject({
      method: "DELETE",
      url: "/agent/self-skills/clobber-pm",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(releaseRes.statusCode).toBe(200);
    const releaseBody = releaseRes.json() as {
      role_id: string;
      version: number;
      granted: RoleSkill[];
    };
    expect(releaseBody.version).toBe(grantedVersion + 1);
    expect(releaseBody.granted.map((s) => s.name)).not.toContain("clobber-pm");

    const afterRelease = readSkillsJson(h, boot.managerRoleId);
    expect(afterRelease.length).toBe(afterGrant.length - 1);
    expect(afterRelease.find((s) => s.name === "clobber-pm")).toBeUndefined();

    const log = readSelfGrantLog(h, boot.managerSessionId);
    expect(log.length).toBe(2);
    expect(log[1]!.state).toBe("released");
    const details = JSON.parse(log[1]!.details_json) as {
      action: string;
      skill: string;
      before: string[];
      after: string[];
    };
    expect(details.action).toBe("release");
    expect(details.skill).toBe("clobber-pm");
    expect(details.before).toEqual(afterGrant.map((s) => s.name));
    expect(details.after).toEqual(afterRelease.map((s) => s.name));

    await teardown(h);
  });

  it("returns 404 when releasing a skill that is not currently granted", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });

    const res = await h.server.inject({
      method: "DELETE",
      url: "/agent/self-skills/never-granted",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("rejects with 403 when allow_self_grant=false", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    // Open policy, grant, then close policy. Release should now be blocked.
    writeCatalogSkill(repo.path, "clobber-pm", "body");
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });
    const grantRes = await h.server.inject({
      method: "POST",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { name: "clobber-pm" },
    });
    expect(grantRes.statusCode).toBe(200);
    await setPolicy(h, boot.workspaceId, {
      allow_self_grant: false,
      allowed_skills: [],
    });

    const releaseRes = await h.server.inject({
      method: "DELETE",
      url: "/agent/self-skills/clobber-pm",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(releaseRes.statusCode).toBe(403);
    await teardown(h);
  });

  it("rejects with 403 when called by a non-persistent role (worker)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "DELETE",
      url: "/agent/self-skills/anything",
      headers: { authorization: `Bearer ${boot.workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    await teardown(h);
  });
});
