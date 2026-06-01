import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync as _mkdtempSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _joinPath, dirname as _dirname } from "node:path";
import { PassThrough } from "node:stream";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import { loadRoleContractAtCommit } from "../src/role-repo.ts";
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
  let pidCounter = 9300;
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
let otherRepo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-roles-edit-");
  roleRepoDir = _mkdtempSync(_joinPath(_tmpdir(), "clobber-rolerepo-"));
  otherRepo = makeRepoFixture("clobber-roles-edit-other-");
});

afterEach(() => {
  repo.cleanup();
  _rmSync(roleRepoDir, { recursive: true, force: true });
  otherRepo.cleanup();
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

// #414 — a content edit advances the commit pin (no role_versions row). These
// helpers read the new substrate: the pin sha, the row count (must stay 0), and
// the committed contract from the per-workspace clone the edit committed onto.
function pinSha(h: Harness, roleId: string): string | null {
  return (
    h.db
      .prepare("SELECT current_commit_sha AS sha FROM roles WHERE id = ?")
      .get(roleId) as { sha: string | null }
  ).sha;
}

function versionRowCount(h: Harness, roleId: string): number {
  return (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(roleId) as { n: number }
  ).n;
}

function committedContract(wsId: string, sha: string) {
  return loadRoleContractAtCommit(_joinPath(_dirname(roleRepoDir), "role-repos", wsId), sha);
}

// The seeded baseline resolves from the shared upstream repo: the per-workspace
// clone is materialized lazily on the first mutating route call.
function seededContract(sha: string) {
  return loadRoleContractAtCommit(roleRepoDir, sha);
}

describe("PATCH /agent/roles/:idOrName — workspace role_edit_policy", () => {
  it("default workspace blocks hooks and permission_mode with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const hooksRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { hooks: { PreToolUse: [] } },
    });
    expect(hooksRes.statusCode).toBe(400);
    expect((hooksRes.json() as { error: string }).error).toMatch(
      /hooks is not editable/,
    );

    const pmRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { permission_mode: "yolo" },
    });
    expect(pmRes.statusCode).toBe(400);
    expect((pmRes.json() as { error: string }).error).toMatch(
      /permission_mode is not editable/,
    );

    await teardown(h);
  });

  it("workspace with custom forbidden_keys=[description] blocks description edits but not hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const patchWs = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${boot.workspaceId}`,
      payload: { role_edit_policy: { forbidden_keys: ["description"] } },
    });
    expect(patchWs.statusCode).toBe(200);

    const descRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "new desc" },
    });
    expect(descRes.statusCode).toBe(400);
    expect((descRes.json() as { error: string }).error).toMatch(
      /description is not editable/,
    );

    // hooks no longer hits the pre-check (the policy is now description-only),
    // but EditBodySchema is .strict() so it still rejects unknown keys — just
    // with a different shape (zod issues, not the "not editable" message).
    const hooksRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { hooks: { PreToolUse: [] } },
    });
    expect(hooksRes.statusCode).toBe(400);
    expect((hooksRes.json() as { error: string }).error).not.toMatch(
      /not editable/,
    );

    await teardown(h);
  });

  it("workspace with empty forbidden_keys=[] lets system_prompt edit succeed (default behavior unaffected)", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const patchWs = await h.server.inject({
      method: "PATCH",
      url: `/workspaces/${boot.workspaceId}`,
      payload: { role_edit_policy: { forbidden_keys: [] } },
    });
    expect(patchWs.statusCode).toBe(200);

    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "with the policy open, normal edits still work" },
    });
    expect(editRes.statusCode).toBe(200);

    await teardown(h);
  });
});

describe("PATCH /agent/roles/:idOrName", () => {
  it("returns 401 without an Authorization header", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      payload: { system_prompt: "you are a tester" },
    });
    expect(res.statusCode).toBe(401);
    await teardown(h);
  });

  it("PATCH only system_prompt advances the pin and preserves skills/allowed_tools/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const beforeSha = pinSha(h, boot.workerRoleId)!;
    const before = seededContract(beforeSha);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "you are a careful tester" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      branch: string;
      sha: string;
      no_new_version: boolean;
    };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.no_new_version).toBe(true);
    expect(body.sha).not.toBe(beforeSha);

    expect(pinSha(h, boot.workerRoleId)).toBe(body.sha);
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    const after = committedContract(boot.workspaceId, body.sha);
    expect(after.systemPrompt).toBe("you are a careful tester");
    expect(after.skills).toEqual(before.skills);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.hooks).toBe(before.hooks);

    await teardown(h);
  });

  it("PATCH only allowed_tools advances the pin and preserves system_prompt/skills/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = seededContract(pinSha(h, boot.workerRoleId)!);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { allowed_tools: ["Read", "Grep"] },
    });
    expect(res.statusCode).toBe(200);

    const after = committedContract(boot.workspaceId, pinSha(h, boot.workerRoleId)!);
    expect(after.allowedTools).toEqual(["Read", "Grep"]);
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.skills).toEqual(before.skills);
    expect(after.hooks).toBe(before.hooks);
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("PATCH only skills advances the pin and preserves system_prompt/allowed_tools/hooks", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const before = seededContract(pinSha(h, boot.workerRoleId)!);

    const skills = [
      { name: "linting", body: "# Linting\nUse the linter." },
      { name: "testing", body: "# Testing\nWrite tests first." },
    ];
    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { skills },
    });
    expect(res.statusCode).toBe(200);

    const after = committedContract(boot.workspaceId, pinSha(h, boot.workerRoleId)!);
    expect(after.skills).toEqual(skills);
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.allowedTools).toEqual(before.allowedTools);
    expect(after.hooks).toBe(before.hooks);
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("PATCH multiple fields at once produces a single commit, no version row", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const beforeSha = pinSha(h, boot.workerRoleId)!;

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {
        system_prompt: "merged",
        allowed_tools: ["Read"],
        skills: [{ name: "s", body: "b" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sha: string };
    expect(body.sha).not.toBe(beforeSha);

    const after = committedContract(boot.workspaceId, body.sha);
    expect(after.systemPrompt).toBe("merged");
    expect(after.allowedTools).toEqual(["Read"]);
    expect(after.skills).toEqual([{ name: "s", body: "b" }]);
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("multiple sequential PATCHes advance the pin each time, never minting a version row", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    let prevSha = pinSha(h, boot.workerRoleId)!;
    for (const prompt of ["prompt a", "prompt b", "prompt c"]) {
      const res = await h.server.inject({
        method: "PATCH",
        url: `/agent/roles/${boot.workerRoleId}`,
        headers: { authorization: `Bearer ${boot.managerToken}` },
        payload: { system_prompt: prompt },
      });
      expect(res.statusCode).toBe(200);
      const sha = (res.json() as { sha: string }).sha;
      expect(sha).not.toBe(prevSha);
      prevSha = sha;
    }

    expect(committedContract(boot.workspaceId, prevSha).systemPrompt).toBe("prompt c");
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("rejects body containing hooks with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "ok", hooks: { PostToolUse: [] } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/hooks/i);

    await teardown(h);
  });

  it("rejects body containing permission_mode with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "ok", permission_mode: "acceptEdits" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/permission_mode/i);

    await teardown(h);
  });

  it("PATCH only description updates roles.description and does NOT advance the pin", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const beforeSha = pinSha(h, boot.workerRoleId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "rewritten description" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      description?: string;
      sha?: string;
    };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(body.description).toBe("rewritten description");
    expect(body.sha).toBeUndefined();

    // Metadata-only: the pin is untouched and no version row is minted.
    expect(pinSha(h, boot.workerRoleId)).toBe(beforeSha);
    const descRow = h.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(boot.workerRoleId) as { description: string };
    expect(descRow.description).toBe("rewritten description");
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("PATCH description + system_prompt advances the pin AND updates the description column", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);
    const beforeSha = pinSha(h, boot.workerRoleId);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "new desc", system_prompt: "new prompt" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role_id: string;
      description?: string;
      sha?: string;
    };
    expect(body.sha).not.toBe(beforeSha);
    expect(body.description).toBe("new desc");

    const descRow = h.db
      .prepare("SELECT description FROM roles WHERE id = ?")
      .get(boot.workerRoleId) as { description: string };
    expect(descRow.description).toBe("new desc");
    expect(committedContract(boot.workspaceId, body.sha!).systemPrompt).toBe("new prompt");
    expect(versionRowCount(h, boot.workerRoleId)).toBe(0);

    await teardown(h);
  });

  it("rejects empty-string description with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { description: "" },
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("rejects empty body with 400", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    await teardown(h);
  });

  it("PATCH by role name resolves within the caller's workspace", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: "/agent/roles/worker",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "by name" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { role_id: string; sha: string };
    expect(body.role_id).toBe(boot.workerRoleId);
    expect(committedContract(boot.workspaceId, body.sha).systemPrompt).toBe("by name");

    await teardown(h);
  });

  it("returns 404 for an unknown role", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: "/agent/roles/nonsense",
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "x" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("returns 404 when role belongs to another workspace", async () => {
    const h = buildHarness();
    const bootA = await bootInWorkspace(h, repo.path);
    const bootB = await bootInWorkspace(h, otherRepo.path);

    const res = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${bootB.workerRoleId}`,
      headers: { authorization: `Bearer ${bootA.managerToken}` },
      payload: { system_prompt: "x" },
    });
    expect(res.statusCode).toBe(404);

    await teardown(h);
  });

  it("live session keeps its boot commit pin after edit; new spawn uses the advanced pin", async () => {
    const h = buildHarness();
    const boot = await bootInWorkspace(h, repo.path);

    const liveSpawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "live",
        label: "boot",
      },
    });
    expect(liveSpawnRes.statusCode).toBe(200);
    const liveSpawn = liveSpawnRes.json() as { session_id: string };

    const livePinned = h.db
      .prepare("SELECT role_commit_sha FROM sessions WHERE id = ?")
      .get(liveSpawn.session_id) as { role_commit_sha: string | null };
    expect(livePinned.role_commit_sha).not.toBeNull();
    const bootSha = livePinned.role_commit_sha!;

    const editRes = await h.server.inject({
      method: "PATCH",
      url: `/agent/roles/${boot.workerRoleId}`,
      headers: { authorization: `Bearer ${boot.managerToken}` },
      payload: { system_prompt: "after edit" },
    });
    expect(editRes.statusCode).toBe(200);
    const edited = editRes.json() as { sha: string };
    expect(edited.sha).not.toBe(bootSha);

    // The live session's pin is frozen at boot — the edit does not retroactively
    // move it.
    const livePinnedAfter = h.db
      .prepare("SELECT role_commit_sha FROM sessions WHERE id = ?")
      .get(liveSpawn.session_id) as { role_commit_sha: string };
    expect(livePinnedAfter.role_commit_sha).toBe(bootSha);

    const newSpawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        workspace_id: boot.workspaceId,
        role_id: boot.workerRoleId,
        prompt: "after",
        label: "boot",
      },
    });
    expect(newSpawnRes.statusCode).toBe(200);
    const newSpawn = newSpawnRes.json() as { session_id: string };
    const newPinned = h.db
      .prepare("SELECT role_commit_sha FROM sessions WHERE id = ?")
      .get(newSpawn.session_id) as { role_commit_sha: string };
    expect(newPinned.role_commit_sha).toBe(edited.sha);

    await teardown(h);
  });
});
