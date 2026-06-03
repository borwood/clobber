import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { createRoleStore } from "../src/role-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { rolePin, sessionPin } from "../src/embody-role.ts";
import { buildAndRegress } from "../src/migration-harness.ts";
import type { Role, Session } from "@clobber/shared";

// #491 — remove the vestigial row-version role-pinning path. These tests define
// the target: commit-backed is the ONLY resolution path; the two operational
// columns are dropped; no code writes version rows except in role_versions
// (historical audit, not a pin).

describe("rm-row-version-pinning (#491) — rolePin() commit-only", () => {
  it("returns a commit pin for a commit-pinned role", () => {
    const role: Role = {
      id: randomUUID(),
      name: "worker",
      persistent: false,
      current_commit: { branch: "worker", sha: "abc123" },
      created_at: 0,
    };
    expect(rolePin(role)).toEqual({ kind: "commit", branch: "worker", sha: "abc123" });
  });

  it("returns null for an unpinned role (no commit, no version)", () => {
    const role: Role = {
      id: randomUUID(),
      name: "worker",
      persistent: false,
      created_at: 0,
    };
    expect(rolePin(role)).toBeNull();
  });
});

describe("rm-row-version-pinning (#491) — sessionPin() commit-only", () => {
  it("returns the session's commit pin when present", () => {
    const role: Role = {
      id: randomUUID(),
      name: "worker",
      persistent: false,
      current_commit: { branch: "worker", sha: "newsha" },
      created_at: 0,
    };
    const session = {
      id: "s1",
      workspace_id: randomUUID(),
      role_id: role.id,
      role_commit: { branch: "worker", sha: "oldsha" },
      runtime_provider: "test",
      pid: 1,
      started_at: 0,
    } as Session;
    // Session's pinned sha, not the role's current pointer.
    expect(sessionPin(session, role)).toEqual({ kind: "commit", branch: "worker", sha: "oldsha" });
  });

  it("falls back to the role's commit pin when the session has no pin", () => {
    const role: Role = {
      id: randomUUID(),
      name: "worker",
      persistent: false,
      current_commit: { branch: "worker", sha: "rolesha" },
      created_at: 0,
    };
    const session = {
      id: "s1",
      workspace_id: randomUUID(),
      role_id: role.id,
      runtime_provider: "test",
      pid: 1,
      started_at: 0,
    } as Session;
    expect(sessionPin(session, role)).toEqual({ kind: "commit", branch: "worker", sha: "rolesha" });
  });

  it("returns null when neither session nor role has any pin", () => {
    const role: Role = {
      id: randomUUID(),
      name: "worker",
      persistent: false,
      created_at: 0,
    };
    const session = {
      id: "s1",
      workspace_id: randomUUID(),
      role_id: role.id,
      runtime_provider: "test",
      pid: 1,
      started_at: 0,
    } as Session;
    expect(sessionPin(session, role)).toBeNull();
  });
});

describe("rm-row-version-pinning (#491) — no version rows on create / seed", () => {
  it("createRoleStore.create() does not set current_version_id (field removed from Role type)", () => {
    const db = createDatabase(":memory:");
    const role = createRoleStore(db).create({ name: "worker", persistent: false });
    // current_version_id is removed from the Role type entirely — no operational pointer.
    expect((role as Record<string, unknown>)["current_version_id"]).toBeUndefined();
    // A version row is still created for test-infrastructure (latestForRole fallback).
    const count = (db.prepare("SELECT COUNT(*) AS n FROM role_versions WHERE role_id = ?").get(role.id) as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  it("seedWorkspaceRoles without forks creates version rows (test-only fallback, no current_version_id pointer)", () => {
    const db = createDatabase(":memory:");
    const ws = db.prepare("INSERT INTO workspaces (id, name, repo_path, created_at) VALUES (?, ?, ?, ?) RETURNING id").get(
      randomUUID(), "ws", "/tmp", Date.now()
    ) as { id: string };
    seedWorkspaceRoles(db, ws.id);
    // Version rows exist (for test content resolution via latestForRole)
    const count = (db.prepare("SELECT COUNT(*) AS n FROM role_versions").get() as { n: number }).n;
    expect(count).toBeGreaterThan(0);
    // But roles have NO current_version_id (that column is dropped)
    const roleWithPointer = db.prepare(
      "SELECT id FROM roles WHERE current_commit_sha IS NULL AND current_commit_branch IS NULL"
    ).all() as Array<{ id: string }>;
    // Roles exist without commit pins
    expect(roleWithPointer.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("rm-row-version-pinning (#491) — migration drops operational columns", () => {
  // Currently FAILS: the migration to drop roles.current_version_id and
  // sessions.role_version_id does not exist yet. After #491, createDatabase
  // runs the new migration and these columns are absent.
  it("reopening a pre-#491 DB drops roles.current_version_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-491-roles-"));
    const path = join(dir, "test.db");
    try {
      buildAndRegress({
        path,
        seed: (db) => {
          createRoleStore(db).create({ name: "worker", persistent: false });
        },
        // No regression needed — the column already exists in the current schema.
        // We're proving the new migration drops it on next open.
        regress: () => {},
      });

      const db = createDatabase(path);
      const roleCols = (
        db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(roleCols).not.toContain("current_version_id");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopening a pre-#491 DB drops sessions.role_version_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-491-sessions-"));
    const path = join(dir, "test.db");
    try {
      buildAndRegress({
        path,
        seed: (db) => {
          createRoleStore(db).create({ name: "worker", persistent: false });
        },
        regress: () => {},
      });

      const db = createDatabase(path);
      const sessionCols = (
        db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(sessionCols).not.toContain("role_version_id");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("role_versions audit table is preserved after migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-491-audit-"));
    const path = join(dir, "test.db");
    try {
      buildAndRegress({
        path,
        seed: (db) => {
          createRoleStore(db).create({ name: "worker", persistent: false });
        },
        regress: () => {},
      });

      const db = createDatabase(path);
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain("role_versions");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
