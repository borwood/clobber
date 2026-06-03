import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createServer } from "../src/server.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawnRequest, AgentSpawner } from "../src/types.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

function tableColumns(db: ReturnType<typeof createDatabase>, table: string): readonly string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tmpDbPath(prefix: string): string {
  return join(
    tmpdir(),
    `clobber-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("role_versions schema (#23)", () => {
  it("creates the role_versions table with the required columns", () => {
    const db = createDatabase(":memory:");
    const cols = tableColumns(db, "role_versions");
    for (const expected of [
      "id",
      "role_id",
      "version",
      "system_prompt",
      "skills_json",
      "allowed_tools_json",
      "allowed_cli_commands_json",
      "hooks_json",
      "created_at",
    ]) {
      expect(cols).toContain(expected);
    }
    db.close();
  });

  it("adds workspace_id to roles (current_version_id dropped in #491)", () => {
    const db = createDatabase(":memory:");
    const cols = tableColumns(db, "roles");
    expect(cols).toContain("workspace_id");
    expect(cols).not.toContain("current_version_id");
    db.close();
  });

  it("sessions does not have role_version_id (dropped in #491)", () => {
    const db = createDatabase(":memory:");
    const cols = tableColumns(db, "sessions");
    expect(cols).not.toContain("role_version_id");
    db.close();
  });
});

describe("role auto-version on create (#23 / #491)", () => {
  it("createRoleStore.create() still creates version rows (test-only fallback) but no current_version_id pointer", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "manager", persistent: true });
    // After #491: no current_version_id field on Role type.
    expect((role as Record<string, unknown>)["current_version_id"]).toBeUndefined();
    // But version row exists for test-infrastructure (latestForRole fallback).
    const v1 = versions.latestForRole(role.id)!;
    expect(v1.role_id).toBe(role.id);
    expect(v1.version).toBe(1);
    expect(v1.system_prompt.length).toBeGreaterThan(0);

    const skills = JSON.parse(v1.skills_json) as Array<{ name: string; body: string }>;
    expect(skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["spawn", "ask", "status", "whoami"]),
    );
    for (const s of skills) expect(s.body.length).toBeGreaterThan(0);

    expect(v1.hooks_json).toContain("__CLOBBER_HOOK_URL__");

    db.close();
  });

  it("no version row is created for non-shipped names (unknown bundles)", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);

    const role = roles.create({ name: "no-such-bundle", persistent: false });
    const all = db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(role.id) as { n: number };
    expect(all.n).toBe(0);

    db.close();
  });
});

describe("backfill on createDatabase (#23 / #491)", () => {
  it("snapshots a pre-existing roles row missing a version row from the shipped bundle", () => {
    const path = tmpDbPath("rv-backfill");
    try {
      const db1 = createDatabase(path);
      db1
        .prepare(
          "INSERT INTO roles (id, name, persistent, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("11111111-1111-4111-8111-111111111111", "manager", 1, Date.now());
      db1.close();

      const db2 = createDatabase(path);
      // After #491: no current_version_id column; instead query role_versions directly.
      const v = db2
        .prepare("SELECT version, system_prompt FROM role_versions WHERE role_id = ? ORDER BY version DESC LIMIT 1")
        .get("11111111-1111-4111-8111-111111111111") as { version: number; system_prompt: string } | null;
      expect(v).not.toBeNull();
      expect(v!.version).toBe(1);
      expect(v!.system_prompt.length).toBeGreaterThan(0);
      db2.close();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("drops orphan roles rows whose name is not in the shipped registry", () => {
    const path = tmpDbPath("rv-orphan");
    try {
      const db1 = createDatabase(path);
      db1
        .prepare(
          "INSERT INTO roles (id, name, persistent, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("22222222-2222-4222-8222-222222222222", "ghost-role", 0, Date.now());
      db1.close();

      const db2 = createDatabase(path);
      const row = db2
        .prepare("SELECT id FROM roles WHERE name = 'ghost-role'")
        .get();
      expect(row).toBeNull();
      db2.close();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("loadAsBundle (#23)", () => {
  it("returns a RoleBundleData with systemPrompt and skills sourced entirely from the DB row", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "manager", persistent: true });
    // create() writes a v1 row for the shipped bundle; get it via latestForRole.
    const v1 = versions.latestForRole(role.id)!;
    const versionId = v1.id;

    db.prepare("UPDATE role_versions SET system_prompt = ? WHERE id = ?").run(
      "MUTATED-VIA-DB",
      versionId,
    );

    const loaded = versions.loadAsBundle(versionId)!;
    expect(loaded.systemPrompt).toBe("MUTATED-VIA-DB");
    expect(loaded.pluginName).toBe("manager");
    expect(Array.isArray(loaded.skills)).toBe(true);
    expect(loaded.skills.length).toBeGreaterThan(0);
    expect(typeof loaded.hooksJson).toBe("string");

    db.close();
  });

  it("returns null for unknown version ids", () => {
    const db = createDatabase(":memory:");
    const versions = createRoleVersionStore(db);
    expect(versions.loadAsBundle("00000000-0000-4000-8000-000000000000")).toBeNull();
    db.close();
  });
});

describe("executeSpawn embodies version-row role (#23 / #491)", () => {
  it("spawns a role with a version row (no-forks path) and session has no role_commit", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-rv-spawn-"));
    try {
      const db = createDatabase(":memory:");
      const workspaces = createWorkspaceStore(db);
      const roles = createRoleStore(db);
      const roleVersions = createRoleVersionStore(db);
      const workspaceRoles = createWorkspaceRoleStore(db);
      const agents = createAgentStore(db);
      const sessions = createSessionStore(db);
      const sessionTokens = createSessionTokenStore(db);
      const calls: AgentSpawnRequest[] = [];
      const spawner: AgentSpawner = (req) => {
        calls.push(req);
        const stdin = new PassThrough();
        stdin.resume();
        return {
          sessionId: req.sessionId!,
          pid: 8123,
          exited: new Promise<number | null>(() => {}),
          stdin,
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
        sessionTokens,
        agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
        agentQuestions: createAgentQuestionStore(db),
        agentQuestionWaiter: createAgentQuestionWaiter(),
        spawner,
        hookUrl: "http://127.0.0.1:3300/hook",
        apiBase: "http://127.0.0.1:3300",
        cliEntry: "/abs/cli/index.ts",
      
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
      try {
        const ws = workspaces.create({ name: "ws", repo_path: repoPath });
        // Seed via seedWorkspaceRoles (no forks) to get a version row for embodiment.
        seedWorkspaceRoles(db, ws.id);
        const role = roles.list().find((r) => r.name === "manager" && r.workspace_id === ws.id)!;

        const res = await server.inject({
          method: "POST",
          url: "/spawn",
          payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "boot" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { session_id: string };

        const session = sessions.get(body.session_id)!;
        // After #491 (no-forks path): role is version-row backed, no commit pin.
        // Session has no role_commit and no role_version_id (column dropped).
        expect(session.role_commit).toBeUndefined();
      } finally {
        await server.close();
        db.close();
      }
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
