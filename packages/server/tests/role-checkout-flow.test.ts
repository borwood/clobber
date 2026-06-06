import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { loadRoleContractAtCommit } from "../src/role-repo.ts";
import { roleContractToSnapshot } from "../src/role-tree-snapshot.ts";
import { commitOnBranch } from "../src/role-checkout-repo.ts";
import { revParse } from "../src/role-git.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #216 PR2 — the working-copy verbs end-to-end. The headline AX: edit a role
// like code, commit to git, NO demotion to a row (closes #396). A full-flow
// integration test through the routes against real git + a real DB.

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  roles: ReturnType<typeof createRoleStore>;
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
  const roles = createRoleStore(db);
  let pid = 9700;
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
    roles,
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
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    roleRepoDir,
  });
  return { server, db, tokens, roles };
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

function pinState(
  h: Harness,
  id: string,
): { branch: string | null; sha: string | null } {
  return h.db
    .prepare(
      "SELECT current_commit_branch AS branch, current_commit_sha AS sha FROM roles WHERE id = ?",
    )
    .get(id) as { branch: string | null; sha: string | null };
}

function versionRowCount(h: Harness, id: string): number {
  return (
    h.db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(id) as {
      n: number;
    }
  ).n;
}

function cacheHas(h: Harness, sha: string): boolean {
  return (
    (
      h.db.prepare("SELECT COUNT(*) AS n FROM materialized_role_cache WHERE sha = ?").get(sha) as {
        n: number;
      }
    ).n > 0
  );
}

function cloneDirFor(wsId: string): string {
  return join(dirname(roleRepoDir), "role-repos", wsId);
}

// #414 — edits no longer demote, so to exercise the lazy cutover we synthesize a
// pre-#395 row-backed role directly: snapshot its committed content into a
// version row and clear the commit pin (the state a not-yet-migrated role is in).
function demoteToRowBacked(h: Harness, workerId: string): void {
  const sha = pinState(h, workerId).sha;
  if (sha === null) throw new Error("expected a seeded commit pin to snapshot from");
  const snapshot = roleContractToSnapshot(loadRoleContractAtCommit(roleRepoDir, sha));
  const maxRow = h.db.prepare("SELECT COALESCE(MAX(version), 0) AS m FROM role_versions WHERE role_id = ?").get(workerId) as { m: number };
  createRoleVersionStore(h.db).create({
    role_id: workerId,
    version: maxRow.m + 1,
    ...snapshot,
  });
  // After #491: current_version_id column is dropped; clear commit pin only.
  h.db
    .prepare(
      "UPDATE roles SET current_commit_branch = NULL, current_commit_sha = NULL WHERE id = ?",
    )
    .run(workerId);
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

async function spawnSession(
  h: Harness,
  wsId: string,
  id: string,
): Promise<{ token: string; sessionId: string }> {
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: id, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn: ${res.body}`);
  const sessionId = (res.json() as { session_id: string }).session_id;
  return { token: h.tokens.mint(sessionId), sessionId };
}

interface CheckoutResponse {
  readonly role_id: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly checkout_dir: string;
}

async function checkout(
  h: Harness,
  token: string,
  idOrName: string,
): Promise<CheckoutResponse> {
  const res = await h.server.inject({
    method: "POST",
    url: `/agent/roles/${encodeURIComponent(idOrName)}/checkout`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.statusCode !== 200) throw new Error(`checkout ${idOrName}: ${res.statusCode} ${res.body}`);
  return res.json() as CheckoutResponse;
}

// Edit a checkout: append a line to system-prompt.md and swap the ROLE.md
// description, the two surfaces the headline flow touches (content + metadata).
function editCheckout(dir: string, newDescription: string): string {
  const promptPath = join(dir, "system-prompt.md");
  const edited = `${readFileSync(promptPath, "utf8")}\nEDIT: working-copy change.\n`;
  writeFileSync(promptPath, edited);
  const rolemd = readFileSync(join(dir, "ROLE.md"), "utf8").replace(
    /^description: .*$/m,
    `description: ${newDescription}`,
  );
  writeFileSync(join(dir, "ROLE.md"), rolemd);
  return edited;
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-role-checkout-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-role-checkout-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#216 role working-copy commit (closes #396)", () => {
  it("checkout → edit → diff → commit advances the pin in git with NO new version row", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const co = await checkout(h, token, "worker");
    expect(co.role_id).toBe(workerId);
    expect(versionRowCount(h, workerId)).toBe(0); // git-backed seed: no version rows

    const editedPrompt = editCheckout(co.checkout_dir, "edited via working copy");

    const diff = await h.server.inject({
      method: "GET",
      url: "/agent/role-checkout/diff",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(diff.statusCode).toBe(200);
    const changedPaths = (diff.json() as { changed: { path: string }[] }).changed.map((c) => c.path);
    expect(changedPaths).toContain("system-prompt.md");
    expect(changedPaths).toContain("ROLE.md");

    const commit = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "edit worker via checkout" },
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const result = commit.json() as { role_id: string; branch: string; sha: string };

    // Still commit-pinned, pin advanced, NO version row minted (no demotion).
    const pin = pinState(h, workerId);
    
    expect(pin.sha).toBe(result.sha);
    expect(pin.sha).not.toBe(co.base_sha);
    expect(versionRowCount(h, workerId)).toBe(0);

    // The tree at the new tip carries the edit.
    const contract = loadRoleContractAtCommit(cloneDirFor(wsId), result.sha);
    expect(contract.systemPrompt).toBe(editedPrompt);

    // The description index column synced from the ROLE.md frontmatter.
    const desc = (
      h.db.prepare("SELECT description AS d FROM roles WHERE id = ?").get(workerId) as { d: string }
    ).d;
    expect(desc).toBe("edited via working copy");

    // The content cache is primed at the new sha.
    expect(cacheHas(h, result.sha)).toBe(true);

    // The checkout was torn down.
    expect(existsSync(co.checkout_dir)).toBe(false);

    await teardown(h);
  });

  it("a session spawned BEFORE the commit keeps its boot commit (no-demotion invariant)", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    // A worker session boots and pins its commit; the manager then edits the
    // worker role through a checkout. The worker's boot pin must survive.
    const { sessionId } = await spawnSession(h, wsId, workerId);
    const bootSha = (
      h.db.prepare("SELECT role_commit_sha AS s FROM sessions WHERE id = ?").get(sessionId) as {
        s: string;
      }
    ).s;
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const co = await checkout(h, token, "worker");
    editCheckout(co.checkout_dir, "a new description");
    const commit = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(commit.statusCode, commit.body).toBe(200);

    // The earlier session's boot pin is untouched — it resumes its exact commit.
    const after = (
      h.db.prepare("SELECT role_commit_sha AS s FROM sessions WHERE id = ?").get(sessionId) as {
        s: string;
      }
    ).s;
    expect(after).toBe(bootSha);
    expect(after).not.toBe((commit.json() as { sha: string }).sha);

    await teardown(h);
  });

  it("checkout on a role with no pin → 422 after #491 (lazy cutover removed)", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    // Put the worker into an unpinned state (no commit, no version pointer).
    demoteToRowBacked(h, workerId);
    expect(pinState(h, workerId).sha).toBeNull();

    // After #491: the lazy cutover is removed; checkout fails with 422.
    const res = await h.server.inject({
      method: "POST",
      url: `/agent/roles/worker/checkout`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);

    await teardown(h);
  });

  it("discard leaves the branch untouched and clears the checkout", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const co = await checkout(h, token, "worker");
    const tipBefore = revParse(cloneDirFor(wsId), co.branch);
    editCheckout(co.checkout_dir, "discarded edit");

    const discard = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/discard",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(discard.statusCode).toBe(200);

    expect(revParse(cloneDirFor(wsId), co.branch)).toBe(tipBefore);
    expect(existsSync(co.checkout_dir)).toBe(false);

    const status = await h.server.inject({
      method: "GET",
      url: "/agent/role-checkout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((status.json() as { open: boolean }).open).toBe(false);

    await teardown(h);
  });

  it("#437 effort-less role (migrated shape): checkout succeeds, ROLE.md omits effort: line, round-trips unchanged", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    // Simulate a migrated role: effort column cleared (the pre-effort shape).
    h.db.prepare("UPDATE roles SET effort = NULL WHERE id = ?").run(workerId);

    // Must not 500 — the dead-end gate this PR closes.
    const co = await checkout(h, token, "worker");

    // The rendered ROLE.md must have NO effort: line.
    const rolemd = readFileSync(join(co.checkout_dir, "ROLE.md"), "utf8");
    expect(rolemd).not.toMatch(/^effort:/m);

    // Round-trip: parse → commit unchanged (no effort in, no effort out).
    const commit = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "regression: effort-less round-trip" },
    });
    expect(commit.statusCode, commit.body).toBe(200);

    // The roles row still has no effort after the commit.
    const row = h.db.prepare("SELECT effort FROM roles WHERE id = ?").get(workerId) as { effort: string | null };
    expect(row.effort).toBeNull();

    await teardown(h);
  });

  it("#437 role WITH effort still renders + round-trips effort: line", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const co = await checkout(h, token, "worker");

    // Worker is seeded with effort: high — the line must appear.
    const rolemd = readFileSync(join(co.checkout_dir, "ROLE.md"), "utf8");
    expect(rolemd).toMatch(/^effort: high$/m);

    // Round-trip: parse the frontmatter and re-render — must be unchanged.
    const commit = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "regression: with-effort round-trip" },
    });
    expect(commit.statusCode, commit.body).toBe(200);

    await teardown(h);
  });

  it("a stale-tip commit refuses without --force, succeeds with it", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const workerId = roleId(h, "worker", wsId);
    const { token } = await spawnSession(h, wsId, roleId(h, "manager", wsId));

    const co = await checkout(h, token, "worker");
    editCheckout(co.checkout_dir, "my edit");

    // The branch advances out-of-band after checkout (another committer).
    const cloneDir = cloneDirFor(wsId);
    const tip = loadRoleContractAtCommit(cloneDir, co.branch);
    commitOnBranch(cloneDir, co.branch, { ...tip, systemPrompt: `${tip.systemPrompt}\nother\n` }, "out-of-band");

    const refused = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(refused.statusCode).toBe(409);

    const forced = await h.server.inject({
      method: "POST",
      url: "/agent/role-checkout/commit",
      headers: { authorization: `Bearer ${token}` },
      payload: { force: true },
    });
    expect(forced.statusCode, forced.body).toBe(200);

    await teardown(h);
  });
});
