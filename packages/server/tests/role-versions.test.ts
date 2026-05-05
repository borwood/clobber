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
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import type { AgentSpawnRequest, AgentSpawner } from "../src/types.ts";

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
      "hooks_json",
      "created_at",
    ]) {
      expect(cols).toContain(expected);
    }
    db.close();
  });

  it("adds current_version_id and workspace_id to roles", () => {
    const db = createDatabase(":memory:");
    const cols = tableColumns(db, "roles");
    expect(cols).toContain("current_version_id");
    expect(cols).toContain("workspace_id");
    db.close();
  });

  it("adds role_version_id to sessions", () => {
    const db = createDatabase(":memory:");
    const cols = tableColumns(db, "sessions");
    expect(cols).toContain("role_version_id");
    db.close();
  });
});

describe("role auto-version on create (#23)", () => {
  it("auto-creates a v1 role_versions row from the shipped manager bundle", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "manager", persistent: true });
    expect(role.current_version_id).toBeDefined();

    const v1 = versions.get(role.current_version_id!)!;
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

  it("leaves current_version_id undefined when the role name is not in the shipped registry", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "no-such-bundle", persistent: false });
    expect(role.current_version_id).toBeUndefined();

    const all = db
      .prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?")
      .get(role.id) as { n: number };
    expect(all.n).toBe(0);

    versions; // referenced for type-check
    db.close();
  });
});

describe("backfill on createDatabase (#23)", () => {
  it("snapshots a pre-existing roles row missing current_version_id from the shipped bundle", () => {
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
      const role = db2
        .prepare("SELECT current_version_id FROM roles WHERE name = 'manager'")
        .get() as { current_version_id: string | null };
      expect(role.current_version_id).not.toBeNull();

      const v = db2
        .prepare("SELECT version, system_prompt FROM role_versions WHERE id = ?")
        .get(role.current_version_id!) as { version: number; system_prompt: string };
      expect(v.version).toBe(1);
      expect(v.system_prompt.length).toBeGreaterThan(0);
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
  it("returns a LoadedRole-shaped value with systemPrompt sourced from the DB row", () => {
    const db = createDatabase(":memory:");
    const roles = createRoleStore(db);
    const versions = createRoleVersionStore(db);

    const role = roles.create({ name: "manager", persistent: true });
    const versionId = role.current_version_id!;

    db.prepare("UPDATE role_versions SET system_prompt = ? WHERE id = ?").run(
      "MUTATED-VIA-DB",
      versionId,
    );

    const loaded = versions.loadAsBundle(versionId)!;
    expect(loaded.systemPrompt).toBe("MUTATED-VIA-DB");
    expect(loaded.manifest.name).toBe("manager");
    expect(typeof loaded.bundleRoot).toBe("string");

    db.close();
  });

  it("returns null for unknown version ids", () => {
    const db = createDatabase(":memory:");
    const versions = createRoleVersionStore(db);
    expect(versions.loadAsBundle("00000000-0000-4000-8000-000000000000")).toBeNull();
    db.close();
  });
});

describe("executeSpawn pins sessions.role_version_id (#23)", () => {
  it("writes role_version_id = role.current_version_id on session create", async () => {
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
        agentQuestions: createAgentQuestionStore(db),
        agentQuestionWaiter: createAgentQuestionWaiter(),
        spawner,
        hookUrl: "http://127.0.0.1:3300/hook",
        apiBase: "http://127.0.0.1:3300",
        cliEntry: "/abs/cli/index.ts",
      });
      try {
        const ws = workspaces.create({ name: "ws", repo_path: repoPath });
        const role = roles.create({ name: "manager", persistent: true });
        workspaceRoles.setCeiling(ws.id, role.id, 1);

        const res = await server.inject({
          method: "POST",
          url: "/spawn",
          payload: { workspace_id: ws.id, role_id: role.id, prompt: "go" },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { session_id: string };

        const session = sessions.get(body.session_id)!;
        expect(role.current_version_id).toBeDefined();
        expect(session.role_version_id).toBe(role.current_version_id!);
      } finally {
        await server.close();
        db.close();
      }
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
