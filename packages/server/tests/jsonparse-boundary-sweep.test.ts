import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";

// #431 — unvalidated `JSON.parse(...) as <T>` persistence-boundary sweep. These
// drive the REAL row-backed read path with an OLD-SHAPE row (a domain field
// missing — the value as it would re-hydrate if persisted before that field
// existed) and assert the boundary now rejects it instead of serving a corrupt
// typed object with `undefined` fields (the #429/#430 failure mode). The harness
// is built WITHOUT a role repo so seeded roles stay row-backed (the unvalidated
// path); a commit-pinned role resolves through the already-version-gated
// materialized cache and never hits these casts.

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
  let pidCounter = 9800;
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
  });
  return { server, db, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

let repo: RepoFixture;

beforeEach(() => {
  repo = makeRepoFixture("clobber-boundary-sweep-");
});

afterEach(() => {
  repo.cleanup();
});

interface Booted {
  workspaceId: string;
  managerToken: string;
  managerSessionId: string;
  managerRoleId: string;
  managerVersionId: string;
}

async function bootRowBacked(h: Harness): Promise<Booted> {
  const wsRes = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws", repo_path: repo.path },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = h.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) {
    throw new Error("seeded manager role not found");
  }
  // After #491: get version id via latest version row (no current_version_id column).
  const latestVersion = h.db
    .prepare("SELECT id FROM role_versions WHERE role_id = ? ORDER BY version DESC LIMIT 1")
    .get(managerRow.id) as { id: string } | null;
  if (latestVersion === null) {
    throw new Error("seeded manager has no version row");
  }

  const bootRes = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };

  return {
    workspaceId: ws.id,
    managerToken: h.tokens.mint(boot.session_id),
    managerSessionId: boot.session_id,
    managerRoleId: managerRow.id,
    managerVersionId: latestVersion.id,
  };
}

describe("#431 — agent-self-skills row-backed skills_json boundary", () => {
  it("control: a well-formed skills_json row is served (200)", async () => {
    const h = buildHarness();
    const boot = await bootRowBacked(h);
    h.db
      .prepare("UPDATE role_versions SET skills_json = ? WHERE id = ?")
      .run(JSON.stringify([{ name: "ok-skill", body: "a body" }]), boot.managerVersionId);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const granted = (res.json() as { granted: Array<{ name: string; body: string }> }).granted;
    expect(granted).toEqual([{ name: "ok-skill", body: "a body" }]);
    await teardown(h);
  });

  it("an old-shape skills_json row (missing `body`) is rejected, not served with body=undefined", async () => {
    const h = buildHarness();
    const boot = await bootRowBacked(h);
    // A skill persisted before `body` was a required RoleSkill field re-hydrates
    // with body === undefined under the raw cast. The boundary must reject it.
    h.db
      .prepare("UPDATE role_versions SET skills_json = ? WHERE id = ?")
      .run(JSON.stringify([{ name: "orphan-skill" }]), boot.managerVersionId);

    const res = await h.server.inject({
      method: "GET",
      url: "/agent/self-skills",
      headers: { authorization: `Bearer ${boot.managerToken}` },
    });
    // Pre-fix the raw cast returns 200 with granted=[{name, body:undefined}].
    expect(res.statusCode).not.toBe(200);
    await teardown(h);
  });
});

describe("#431 — workspace-session-summaries questions_json boundary", () => {
  it("control: a well-formed open question is surfaced in the summary", async () => {
    const h = buildHarness();
    const boot = await bootRowBacked(h);
    h.db
      .prepare(
        `INSERT INTO agent_questions (id, session_id, questions_json, status, answer, asked_at, answered_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        "q-ok",
        boot.managerSessionId,
        JSON.stringify([{ question: "Proceed?", multi_select: false }]),
        Date.now(),
      );

    const summaries = createWorkspaceSessionSummaries(h.db).list(boot.workspaceId);
    const managerSummary = summaries.find((s) => s.session_id === boot.managerSessionId);
    expect(managerSummary?.open_question?.questions[0]?.question).toBe("Proceed?");
    expect(managerSummary?.open_question?.questions[0]?.multi_select).toBe(false);
    await teardown(h);
  });

  it("an old-shape questions_json (missing `multi_select`) is rejected at the read boundary", async () => {
    const h = buildHarness();
    const boot = await bootRowBacked(h);
    // A question persisted before `multi_select` existed re-hydrates with it
    // undefined under the raw cast; the boundary must throw rather than surface a
    // corrupt AskQuestion to the floor view.
    h.db
      .prepare(
        `INSERT INTO agent_questions (id, session_id, questions_json, status, answer, asked_at, answered_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        "q-stale",
        boot.managerSessionId,
        JSON.stringify([{ question: "legacy question" }]),
        Date.now(),
      );

    const summaries = createWorkspaceSessionSummaries(h.db);
    expect(() => summaries.list(boot.workspaceId)).toThrow();
    await teardown(h);
  });
});
