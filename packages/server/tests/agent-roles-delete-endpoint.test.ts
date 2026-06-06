import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let roleRepoDir: string;

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  let pidCounter = 9000;
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

let repo: RepoFixture;
let otherRepo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-roles-delete-");
  otherRepo = makeRepoFixture("clobber-roles-delete-other-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-roles-delete-repo-"));
});

afterEach(() => {
  repo.cleanup();
  otherRepo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerSessionId: string;
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
    managerSessionId: boot.session_id,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
  };
}

async function fork(h: Harness, boot: Booted, source: string, newName: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: `/agent/roles/${source}/fork`,
    headers: { authorization: `Bearer ${boot.managerToken}` },
    payload: { new_name: newName },
  });
  if (res.statusCode !== 201) throw new Error(`fork ${newName}: ${res.body}`);
  return (res.json() as { role_id: string }).role_id;
}

async function setCeiling(h: Harness, boot: Booted, roleId: string, max: number): Promise<void> {
  const res = await h.server.inject({
    method: "PUT",
    url: `/agent/roles/${roleId}/ceiling`,
    headers: { authorization: `Bearer ${boot.managerToken}` },
    payload: { max_concurrent: max },
  });
  if (res.statusCode !== 200) throw new Error(`ceiling ${roleId}: ${res.body}`);
}

async function spawnFor(h: Harness, boot: Booted, roleId: string): Promise<{ agent_id: string; session_id: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: boot.workspaceId, role_id: roleId, prompt: "go", label: "x" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn ${roleId}: ${res.body}`);
  return res.json() as { agent_id: string; session_id: string };
}

function del(h: Harness, boot: Booted, target: string, force = false) {
  return h.server.inject({
    method: "DELETE",
    url: `/agent/roles/${target}${force ? "?force=true" : ""}`,
    headers: { authorization: `Bearer ${boot.managerToken}` },
  });
}

describe("DELETE /agent/roles/:idOrName", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const scratch = await fork(h, boot, "worker", "scratch");
    const res = await h.server.inject({ method: "DELETE", url: `/agent/roles/${scratch}` });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("deletes an inert fork (ceiling 0, no sessions): row + version + ceiling gone, drops out of the list", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const scratch = await fork(h, boot, "worker", "scratch");
    await setCeiling(h, boot, scratch, 0);

    const res = await del(h, boot, "scratch");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { role_id: string; name: string; deleted_branch: string | null };
    expect(body.role_id).toBe(scratch);
    expect(body.name).toBe("scratch");
    expect(body.deleted_branch).toBe("scratch");

    // Row + cascaded rows are gone.
    const roleRow = h.db.prepare("SELECT id FROM roles WHERE id = ?").get(scratch);
    expect(roleRow).toBeNull();
    const ceilingRows = (
      h.db.prepare("SELECT COUNT(*) AS n FROM workspace_role_ceilings WHERE role_id = ?").get(scratch) as { n: number }
    ).n;
    expect(ceilingRows).toBe(0);

    // No longer in the list.
    const listRes = await h.server.inject({
      method: "GET",
      url: "/agent/roles",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    const names = (listRes.json() as { roles: Array<{ name: string }> }).roles.map((r) => r.name).sort();
    expect(names).toEqual(["manager", "worker"]);

    await teardown(h);
  });

  it("removes the fork branch so the same name can be forked again", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const scratch = await fork(h, boot, "worker", "scratch");
    await setCeiling(h, boot, scratch, 0);
    expect((await del(h, boot, "scratch")).statusCode).toBe(200);

    // A leftover branch would make re-forking the same name fail; it succeeds.
    const reforked = await fork(h, boot, "worker", "scratch");
    expect(typeof reforked).toBe("string");
    await teardown(h);
  });

  it("scrubs the role's trigger_overrides config ref", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const scratch = await fork(h, boot, "worker", "scratch");
    await setCeiling(h, boot, scratch, 0);
    h.db
      .prepare("UPDATE workspaces SET trigger_overrides = ? WHERE id = ?")
      .run(JSON.stringify({ [scratch]: { disabled_trigger_ids: ["idle"] } }), boot.workspaceId);

    expect((await del(h, boot, "scratch")).statusCode).toBe(200);

    const overrides = JSON.parse(
      (h.db.prepare("SELECT trigger_overrides FROM workspaces WHERE id = ?").get(boot.workspaceId) as {
        trigger_overrides: string;
      }).trigger_overrides,
    ) as Record<string, unknown>;
    expect(scratch in overrides).toBe(false);
    await teardown(h);
  });

  it("refuses a persistent role without --force, then deletes it with --force", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    // A persistent fork with no live session and ceiling 0 isolates the
    // persistent guard from the live-session hard stop.
    const clone = await fork(h, boot, "manager", "manager-clone");
    await setCeiling(h, boot, clone, 0);

    const refused = await del(h, boot, "manager-clone");
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toMatch(/persistent/i);

    const forced = await del(h, boot, "manager-clone", true);
    expect(forced.statusCode, forced.body).toBe(200);
    expect(h.db.prepare("SELECT id FROM roles WHERE id = ?").get(clone)).toBeNull();
    await teardown(h);
  });

  it("refuses a role with spawned agents under a non-zero ceiling, --force overrides", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const busy = await fork(h, boot, "worker", "busy"); // inherits ceiling 1
    const spawned = await spawnFor(h, boot, busy);
    // End the session so the agent row remains but there is no LIVE session —
    // isolating the spawned-agents soft guard from the live-session hard stop.
    h.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(1, spawned.session_id);

    const refused = await del(h, boot, "busy");
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toMatch(/agent/i);

    const forced = await del(h, boot, "busy", true);
    expect(forced.statusCode, forced.body).toBe(200);
    await teardown(h);
  });

  it("refuses a role with a LIVE session even with --force (hard stop)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const live = await fork(h, boot, "worker", "livewire"); // ceiling 1
    await spawnFor(h, boot, live); // leaves a live session

    const refused = await del(h, boot, "livewire");
    expect(refused.statusCode).toBe(409);

    const forced = await del(h, boot, "livewire", true);
    expect(forced.statusCode).toBe(409);
    expect((forced.json() as { error: string }).error).toMatch(/live|session|reap/i);

    // Still present.
    expect(h.db.prepare("SELECT id FROM roles WHERE id = ?").get(live)).not.toBeNull();
    await teardown(h);
  });

  it("deletes a seeded role pinned to a shared <name>-default branch without touching the branch", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    // The seeded worker is pinned to `worker-default` (shared upstream lineage),
    // not its own fork branch — deleting it removes the row but reports no branch
    // and must NOT error on the protected ref.
    await setCeiling(h, boot, boot.workerRoleId, 0);

    const res = await del(h, boot, "worker");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { deleted_branch: string | null };
    expect(body.deleted_branch).toBeNull();
    expect(h.db.prepare("SELECT id FROM roles WHERE id = ?").get(boot.workerRoleId)).toBeNull();

    // The clone is intact (the protected default ref was never touched), so the
    // repo still forks.
    const reforked = await fork(h, boot, "manager", "worker");
    expect(typeof reforked).toBe("string");
    await teardown(h);
  });

  it("returns 404 for an unknown role name", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await del(h, boot, "nonsense");
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });

  it("returns 404 when the role belongs to another workspace", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);
    const scratchB = await fork(h, bootB, "worker", "scratch");
    await setCeiling(h, bootB, scratchB, 0);

    const res = await del(h, bootA, scratchB);
    expect(res.statusCode).toBe(404);
    await teardown(h);
  });
});
