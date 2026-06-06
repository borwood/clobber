import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

// Regression test for #387: skill edits persisted via PATCH /agent/roles/:name
// must survive re-materialization on the NEXT spawn. The on-disk plugin surface
// (.clobber/roles/<name>/skills/) must reflect the git-backed authoritative
// source (workspace clone branch tip), never the engine plugin-template default.

let roleRepoDir: string;

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

async function createWorkspace(h: Harness, repoPath: string): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: `ws-${repoPath}`, repo_path: repoPath },
  });
  if (res.statusCode !== 201) throw new Error(`create ws: ${res.body}`);
  return (res.json() as { id: string }).id;
}

function workerId(h: Harness, wsId: string): string {
  const row = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", wsId) as { id: string } | null;
  if (row === null) throw new Error(`worker role not seeded in workspace ${wsId}`);
  return row.id;
}

async function spawnManager(
  h: Harness,
  wsId: string,
): Promise<{ token: string }> {
  const managerId = (
    h.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", wsId) as { id: string } | null
  )?.id;
  if (managerId === undefined) throw new Error("manager role not found");

  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: managerId, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn manager: ${res.body}`);
  const sessionId = (res.json() as { session_id: string }).session_id;
  return { token: h.tokens.mint(sessionId) };
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-skill-edit-mat-");
  roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-skill-edit-repo-"));
});
afterEach(() => {
  repo.cleanup();
  rmSync(roleRepoDir, { recursive: true, force: true });
});

describe("#387 skill-edit materialize regression", () => {
  it("skill edited via PATCH /agent/roles materializes from the edited git tree, not the plugin-template default", async () => {
    const h = buildHarness();
    const wsId = await createWorkspace(h, repo.path);
    const { token } = await spawnManager(h, wsId);

    // Pre-edit spawn: materialize the worker with the plugin-template defaults
    // BEFORE the edit. This puts template skill dirs (e.g. "status") on disk.
    // A stale writeSkills implementation that is purely additive will leave
    // these dirs behind after the edit, causing the bug.
    const wId = workerId(h, wsId);
    const preEditSpawn = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: wsId, role_id: wId, prompt: "go", label: "pre-edit" },
    });
    expect(preEditSpawn.statusCode, preEditSpawn.body).toBe(200);

    // Patch the worker role: replace ALL skills with a single custom skill.
    // The plugin-template "worker" has skills like "status", "spawn", etc.
    // A successful fix means only our custom skill lands on disk after the
    // next spawn — the template skill dirs must be removed.
    const CUSTOM_SKILL_NAME = "my-custom-skill";
    const CUSTOM_SKILL_BODY = "# MY CUSTOM SKILL\nEdited for #387 regression test.";

    const patchRes = await h.server.inject({
      method: "PATCH",
      url: "/agent/roles/worker",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        skills: [{ name: CUSTOM_SKILL_NAME, body: CUSTOM_SKILL_BODY }],
      },
    });
    expect(patchRes.statusCode, patchRes.body).toBe(200);
    const patchBody = patchRes.json() as { sha: string; no_new_version: boolean };
    // Edit advances the git pin; a new version row must NOT be minted.
    expect(typeof patchBody.sha).toBe("string");
    expect(patchBody.no_new_version).toBe(true);

    // Post-edit spawn: re-materialize from the edited git tree.
    // writeSkills must clear the skills dir before writing so removed skills
    // do not linger from the pre-edit spawn above.
    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: wsId, role_id: wId, prompt: "go", label: "post-edit" },
    });
    expect(spawnRes.statusCode, spawnRes.body).toBe(200);

    const pluginDir = join(repo.path, ".clobber", "roles", "worker");

    // The edited skill MUST be present on disk.
    const customSkillPath = join(pluginDir, "skills", CUSTOM_SKILL_NAME, "SKILL.md");
    expect(existsSync(customSkillPath), `expected edited skill at ${customSkillPath}`).toBe(true);
    expect(readFileSync(customSkillPath, "utf8")).toBe(CUSTOM_SKILL_BODY);

    // A plugin-template skill (e.g. "status") must NOT be present: we
    // replaced all skills, so the materialized dir must reflect the edit.
    const templateSkillPath = join(pluginDir, "skills", "status", "SKILL.md");
    expect(
      existsSync(templateSkillPath),
      `template skill "status" must not be materialized after edit replaced all skills`,
    ).toBe(false);

    await teardown(h);
  });
});
