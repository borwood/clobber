import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "@clobber/server/server.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { createEventStore } from "@clobber/server/event-store.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { createRoleVersionStore } from "@clobber/server/role-version-store.ts";
import { createWorkspaceRoleStore } from "@clobber/server/workspace-role-store.ts";
import { createAgentStore } from "@clobber/server/agent-store.ts";
import { createSessionStore } from "@clobber/server/session-store.ts";
import { createWorkspaceSessionSummaries } from "@clobber/server/workspace-session-summaries.ts";
import { createSessionTokenStore } from "@clobber/server/session-token-store.ts";
import { createAgentStatusStore } from "@clobber/server/agent-status-store.ts";
import { createAgentStatusLogStore } from "@clobber/server/agent-status-log-store.ts";
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import type { ManagerSkillPolicy } from "@clobber/shared";
import { run } from "../src/main.ts";

interface Harness {
  app: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  baseUrl: string;
  managerToken: string;
  workspaceId: string;
  repoPath: string;
  roleRepoDir: string;
}

let harness: Harness;

function makeAgentStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

beforeAll(async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-ws-patch-repo-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-ws-patch-rolerepo-"));

  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);

  let pidCounter = 9500;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pidCounter += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: pidCounter,
      exited: new Promise<number | null>(() => {}),
      stdin: makeAgentStdin(),
      kill: () => {},
    };
  };

  const app = createServer({
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
    roleRepoDir,
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const wsRes = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "patch-test-ws", repo_path: repoPath },
  });
  if (wsRes.statusCode !== 201) throw new Error(`create ws: ${wsRes.body}`);
  const ws = wsRes.json() as { id: string };

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string } | null;
  if (managerRow === null) throw new Error("seed missing manager");

  const bootRes = await app.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: managerRow.id, prompt: "boot", label: "boot" },
  });
  if (bootRes.statusCode !== 200) throw new Error(`boot: ${bootRes.body}`);
  const boot = bootRes.json() as { session_id: string };
  const managerToken = tokens.mint(boot.session_id);

  harness = { app, db, baseUrl, managerToken, workspaceId: ws.id, repoPath, roleRepoDir };
});

afterAll(async () => {
  await harness.app.close();
  harness.db.close();
  rmSync(harness.repoPath, { recursive: true, force: true });
  rmSync(harness.roleRepoDir, { recursive: true, force: true });
});

function captureStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stderr.on("data", (c: Buffer) => err.push(c));
  return {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
  };
}

function envFor(token: string): NodeJS.ProcessEnv {
  return {
    CLOBBER_API_BASE: harness.baseUrl,
    CLOBBER_SESSION_TOKEN: token,
  };
}

function currentPolicy(): ManagerSkillPolicy {
  const row = harness.db
    .prepare("SELECT manager_skill_policy FROM workspaces WHERE id = ?")
    .get(harness.workspaceId) as { manager_skill_policy: string };
  return JSON.parse(row.manager_skill_policy) as ManagerSkillPolicy;
}

describe("clobber CLI — workspace patch (#454)", () => {
  it("--allow-skill appends to allowed_skills without clobbering existing entries", async () => {
    const s = captureStreams();

    // Seed a known starting state via the server directly.
    await harness.app.inject({
      method: "PATCH",
      url: `/workspaces/${harness.workspaceId}`,
      payload: {
        manager_skill_policy: { allow_self_grant: false, allowed_skills: ["existing-skill"] },
      },
    });

    const code = await run({
      argv: ["workspace", "patch", "--allow-skill", "new-skill"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    expect(policy.allowed_skills).toContain("existing-skill");
    expect(policy.allowed_skills).toContain("new-skill");
    expect(policy.allow_self_grant).toBe(false);
  });

  it("--allow-skill is idempotent — does not add duplicates", async () => {
    const s = captureStreams();

    await harness.app.inject({
      method: "PATCH",
      url: `/workspaces/${harness.workspaceId}`,
      payload: {
        manager_skill_policy: { allow_self_grant: false, allowed_skills: ["a", "b"] },
      },
    });

    const code = await run({
      argv: ["workspace", "patch", "--allow-skill", "a"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    const count = policy.allowed_skills.filter((x) => x === "a").length;
    expect(count).toBe(1);
  });

  it("--disallow-skill removes the named skill from allowed_skills", async () => {
    const s = captureStreams();

    await harness.app.inject({
      method: "PATCH",
      url: `/workspaces/${harness.workspaceId}`,
      payload: {
        manager_skill_policy: { allow_self_grant: false, allowed_skills: ["keep", "remove-me"] },
      },
    });

    const code = await run({
      argv: ["workspace", "patch", "--disallow-skill", "remove-me"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    expect(policy.allowed_skills).toContain("keep");
    expect(policy.allowed_skills).not.toContain("remove-me");
  });

  it("--allow-self-grant true enables the flag and preserves allowed_skills", async () => {
    const s = captureStreams();

    await harness.app.inject({
      method: "PATCH",
      url: `/workspaces/${harness.workspaceId}`,
      payload: {
        manager_skill_policy: { allow_self_grant: false, allowed_skills: ["preserved"] },
      },
    });

    const code = await run({
      argv: ["workspace", "patch", "--allow-self-grant", "true"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    expect(policy.allow_self_grant).toBe(true);
    expect(policy.allowed_skills).toContain("preserved");
  });

  it("--allow-self-grant false disables the flag", async () => {
    const s = captureStreams();

    await harness.app.inject({
      method: "PATCH",
      url: `/workspaces/${harness.workspaceId}`,
      payload: {
        manager_skill_policy: { allow_self_grant: true, allowed_skills: [] },
      },
    });

    const code = await run({
      argv: ["workspace", "patch", "--allow-self-grant", "false"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    expect(policy.allow_self_grant).toBe(false);
  });

  it("--json <body> passthrough merges raw fields into the PATCH body", async () => {
    const s = captureStreams();

    const code = await run({
      argv: [
        "workspace",
        "patch",
        "--json",
        JSON.stringify({ manager_skill_policy: { allow_self_grant: true, allowed_skills: ["via-json"] } }),
      ],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const policy = currentPolicy();
    expect(policy.allow_self_grant).toBe(true);
    expect(policy.allowed_skills).toContain("via-json");
  });

  it("--allow-skill and --json output flag together returns JSON", async () => {
    const s = captureStreams();

    const code = await run({
      argv: ["workspace", "patch", "--allow-skill", "json-mode-skill", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);

    const parsed = JSON.parse(s.out()) as { id: string; manager_skill_policy: ManagerSkillPolicy };
    expect(parsed.id).toBe(harness.workspaceId);
    expect(parsed.manager_skill_policy.allowed_skills).toContain("json-mode-skill");
  });

  it("no flags exits 2 and message names the available flags", async () => {
    const s = captureStreams();

    const code = await run({
      argv: ["workspace", "patch"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--allow-skill|--disallow-skill|--allow-self-grant|--json/i);
  });

  it("--json alone (no body, no other flags) exits 2", async () => {
    const s = captureStreams();

    const code = await run({
      argv: ["workspace", "patch", "--json"],
      env: envFor(harness.managerToken),
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(2);
    expect(s.err()).toMatch(/--allow-skill|--disallow-skill|--allow-self-grant|--json/i);
  });

  it("with no CLOBBER_SESSION_TOKEN, fails fast with the local error (not a 401) (#688)", async () => {
    // Unlike `workspace create`, `patch` resolves its target workspace via
    // `GET /agent/me` first, which IS agent-authed — it must still demand a
    // real session token from a bare human shell rather than hitting the
    // server and surfacing a raw network 401.
    const s = captureStreams();

    await expect(
      run({
        argv: ["workspace", "patch", "--allow-self-grant", "true"],
        env: { CLOBBER_API_BASE: harness.baseUrl },
        stdout: s.stdout,
        stderr: s.stderr,
      }),
    ).rejects.toThrow(/CLOBBER_SESSION_TOKEN is not set/);
  });
});
