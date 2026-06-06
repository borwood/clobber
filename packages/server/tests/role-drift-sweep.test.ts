import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
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
import { git, readTreeAtCommit, revParse } from "../src/role-git.ts";
import { commitContractOnBranch, loadRoleContractAtCommit } from "../src/role-repo.ts";
import { composePromptModules } from "../src/compose-prompt-modules.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import type { BootContext } from "@clobber/shared";

// #401 step-2 — drift-sweep integration tests:
// (a) K-ahead count for drifted role, 0 for in-sync
// (b) base-derived role counts vs upstream/base (resolves correctly, not arbitrary default)
// (c) staleness note renders in the response
// (d) zero-drift is near-silent (dilution guard)
// (e) signal appears in the composed boot surface (compose-path assertion, not live restart)

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof createSessionTokenStore>;
  wsId: string;
  managerToken: string;
  roleRepoDir: string;
  base: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

let harness: Harness;

function advanceUpstreamManagerDefault(roleRepoDir: string, k: number): void {
  git(roleRepoDir, "checkout", "-q", "manager-default");
  for (let i = 1; i <= k; i++) {
    const tree = readTreeAtCommit(roleRepoDir, "manager-default");
    const promptContent = tree.get("system-prompt.md") ?? "";
    writeFileSync(join(roleRepoDir, "system-prompt.md"), `${promptContent}\n# DRIFT-SWEEP-UPDATE-${i}\n`);
    git(roleRepoDir, "add", "-A");
    git(
      roleRepoDir,
      "-c", "user.email=clobber@local",
      "-c", "user.name=clobber",
      "-c", "commit.gpgsign=false",
      "commit", "-q", "-m", `drift sweep upstream update ${i}`,
    );
  }
  git(roleRepoDir, "checkout", "-q", "base");
}

function cloneDirFor(wsId: string): string {
  return join(dirname(harness.roleRepoDir), "role-repos", wsId);
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-drift-sweep-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-drift-sweep-role-repo-"));

  const db = createDatabase(":memory:");
  const tokens = createSessionTokenStore(db);
  let pid = 8800;
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

  // Start server on a real port so the http provider for assertion (e) can reach it.
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const wsRes = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "drift-sweep-ws", repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("manager seed missing");

  const bootRes = await server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  // Advance manager-default upstream by 2 commits BEFORE fetch.
  // Workspace pins are at the OLD sha; upstream will be ahead.
  advanceUpstreamManagerDefault(roleRepoDir, 2);

  // Fetch creates the clone and pulls upstream refs.
  const fetchRes = await server.inject({
    method: "POST",
    url: "/agent/roles/fetch",
    headers: auth(managerToken),
  });
  if (fetchRes.statusCode !== 200) throw new Error(`fetch: ${fetchRes.body}`);

  harness = { server, db, tokens, wsId: ws.id, managerToken, roleRepoDir, base };
});

afterAll(async () => {
  await harness.server.close();
  harness.db.close();
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
});

function bootContextFor(wsId: string): BootContext {
  const managerRow = harness.db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", wsId) as { id: string } | null;
  if (managerRow === null) throw new Error("manager row missing");
  return {
    workspace_id: wsId,
    agent_id: "test-agent",
    role_id: managerRow.id,
    role_name: "manager",
    persistent: true,
  };
}

describe("roles drift-sweep (#401 step-2)", () => {
  it("(a) counts manager 2 ahead, worker 0 ahead (in sync)", async () => {
    const res = await fetch(`${harness.base}/agent/roles/drift-sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bootContextFor(harness.wsId)),
    });
    const text = await res.text();
    expect(res.ok, text).toBe(true);
    expect(text).toContain("manager");
    expect(text).toContain("2 commit");
    // worker is in sync; either "in sync" line or absent from drifted section
    expect(text).not.toMatch(/worker:.*commit.*ahead/);
  });

  it("(b) base-derived role (designer) counts vs upstream/base, not an arbitrary default", async () => {
    const cloneDir = cloneDirFor(harness.wsId);
    const baseRef = "upstream/base";
    const baseContract = loadRoleContractAtCommit(cloneDir, baseRef);
    const designerRef = commitContractOnBranch(
      cloneDir,
      "designer-drift",
      revParse(cloneDir, baseRef),
      baseContract,
      "designer: fork from base layer for drift test",
    );
    harness.db
      .prepare(
        "INSERT INTO roles (id, name, persistent, workspace_id, current_commit_branch, current_commit_sha, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)",
      )
      .run(
        "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d001",
        "designer-drift",
        harness.wsId,
        "designer-drift",
        designerRef.sha,
        Date.now(),
      );

    const res = await fetch(`${harness.base}/agent/roles/drift-sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bootContextFor(harness.wsId)),
    });
    const text = await res.text();
    expect(res.ok, text).toBe(true);
    // designer-drift is in sync with upstream/base (0 ahead) — so it must NOT appear in the
    // drifted section. If the bug were present (wrong upstream target like manager-default),
    // the designer would appear as behind because manager-default is 2 ahead of designer.
    expect(text).not.toMatch(/designer-drift:.*commit.*ahead/);
  });

  it("(c) staleness note appears in the response text", async () => {
    const res = await fetch(`${harness.base}/agent/roles/drift-sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bootContextFor(harness.wsId)),
    });
    const text = await res.text();
    // Must mention when refs were last fetched
    expect(text).toMatch(/fetched/i);
  });

  it("(d) zero-drift is near-silent — one terse line, not a paragraph", async () => {
    // Create a separate workspace where upstream is NOT advanced past local pins.
    const repoPath2 = mkdtempSync(join(tmpdir(), "clobber-drift-sync-repo-"));
    writeFileSync(join(repoPath2, ".git"), "gitdir: stub\n");

    const wsRes = await harness.server.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "drift-sync-ws", repo_path: repoPath2 },
    });
    expect(wsRes.statusCode, wsRes.body).toBe(201);
    const ws2 = wsRes.json() as { id: string };

    const managerRow = harness.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws2.id) as { id: string } | null;
    if (managerRow === null) throw new Error("manager seed missing for ws2");

    const bootRes = await harness.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws2.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
    });
    const boot = bootRes.json() as { session_id: string };
    const token2 = harness.tokens.mint(boot.session_id);

    // Fetch so clone exists (upstream refs already up-to-date — no advance).
    await harness.server.inject({
      method: "POST",
      url: "/agent/roles/fetch",
      headers: { Authorization: `Bearer ${token2}` },
    });

    // The workspace was seeded with the pre-advance manager sha, but we want zero-drift.
    // Advance the pins to match the upstream tips now that the clone has the refs.
    const cloneDir2 = cloneDirFor(ws2.id);
    const upstreamManagerSha = revParse(cloneDir2, "upstream/manager-default");
    harness.db
      .prepare("UPDATE roles SET current_commit_sha = ? WHERE name = 'manager' AND workspace_id = ?")
      .run(upstreamManagerSha, ws2.id);

    const ws2ManagerRow = harness.db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws2.id) as { id: string } | null;
    const ctx2: BootContext = {
      workspace_id: ws2.id,
      agent_id: "test-agent-2",
      role_id: ws2ManagerRow?.id ?? "unknown",
      role_name: "manager",
      persistent: true,
    };

    const res = await fetch(`${harness.base}/agent/roles/drift-sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx2),
    });
    const text = await res.text();
    // Zero-drift: near-silent — single line, no multi-line block
    const nonEmptyLines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBe(1);
    expect(text).toMatch(/in sync/i);

    rmSync(repoPath2, { recursive: true, force: true });
  });

  it("(e) drift signal appears in the composed boot surface (compose-path assertion)", async () => {
    // Test the http-provider compose path directly: build a catalog entry pointing
    // at the running server, call composePromptModules, assert the output contains
    // the drift signal. This validates end-to-end without a live restart (#498).
    const catalog = [
      {
        name: "roles-drift-sweep",
        definition: {
          kind: "dynamic" as const,
          provider: {
            kind: "http" as const,
            url: `${harness.base}/agent/roles/drift-sweep`,
          },
        },
      },
    ];
    const refs = [{ name: "roles-drift-sweep", enabled: true }];
    const ctx = bootContextFor(harness.wsId);

    const segments = await composePromptModules(refs, catalog, ctx, {});
    expect(segments).toHaveLength(1);
    const text = segments[0];
    // The drift signal must include the Role drift header and the manager's count
    expect(text).toContain("[Role drift");
    expect(text).toContain("manager");
    expect(text).toContain("2 commit");
  });
});
