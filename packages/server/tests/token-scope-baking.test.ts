// #567 — Track C Step 5: token-scope baking + NULL-scope fall-back-to-live.
//
// FLOOR-BRICK real-path test:
//   Part A (migration safety): seed a DB with a live session+token at the post-
//     migration schema, regress by DROPping scope_json, reopen via the real
//     createDatabase entrypoint, assert that a NULL-scope token still authorizes
//     exactly as before (fall-back-to-live fires).
//   Part B (baked-path exercise): register a token with a restricted baked scope;
//     assert authorizeCommand honours the baked scope and refuses commands outside
//     it even when the role+workspace would have allowed them — proving the baked
//     path is actually consulted, not bypassed.

import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.ts";
import { buildAndRegress } from "../src/migration-harness.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { authorizeCommand } from "../src/routes/_agent-auth.ts";
import { allCapabilityNames, isActionAllowed } from "@clobber/shared";

describe("token-scope baking — FLOOR-BRICK (#567)", () => {
  it("Part A: NULL-scope token from prior schema still authorizes via live fall-back after migration", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-scope-a-repo-"));
    const dir = mkdtempSync(join(tmpdir(), "clobber-scope-a-db-"));
    const dbPath = join(dir, "test.db");

    let capturedToken!: string;
    let capturedSessionId!: string;
    let capturedWorkspaceId!: string;

    try {
      buildAndRegress({
        path: dbPath,
        seed: (db) => {
          const workspaces = createWorkspaceStore(db);
          const ws = workspaces.create({ name: "brick-ws", repo_path: repoPath });
          capturedWorkspaceId = ws.id;
          seedWorkspaceRoles(db, ws.id);
          const roles = createRoleStore(db);
          const managerRole = roles.findInWorkspace(ws.id, "manager");
          if (managerRole === null) throw new Error("manager role not seeded");
          const agents = createAgentStore(db);
          const agent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
          const sessions = createSessionStore(db);
          capturedSessionId = randomUUID();
          sessions.create({
            id: capturedSessionId,
            agent_id: agent.id,
            workspace_id: ws.id,
            role_id: managerRole.id,
            pid: 1,
          });
          const tokens = createSessionTokenStore(db);
          // mint with no scope (simulates a token that pre-dates scope baking)
          capturedToken = tokens.mint(capturedSessionId);
        },
        regress: (db) => {
          // Simulate an older DB that has no scope_json column yet.
          db.exec("ALTER TABLE session_tokens DROP COLUMN scope_json");
        },
      });

      // Reopen through the real entrypoint — migrateSessionTokenScope adds the
      // column back (NULLABLE, no default) so existing rows get scope_json = NULL.
      const db = createDatabase(dbPath);
      try {
        const tokens = createSessionTokenStore(db);
        const roles = createRoleStore(db);
        const roleVersions = createRoleVersionStore(db);
        const workspaces = createWorkspaceStore(db);
        const sessions = createSessionStore(db);

        // The migrated token row must have scope_json = NULL.
        const lookup = tokens.lookup(capturedToken);
        expect(lookup).not.toBeNull();
        expect(lookup!.scope_json).toBeNull();

        // Fall-back-to-live: NULL scope → live 2-tier resolution.
        // manager role has ["*"], workspace has default permissive scope → status allowed.
        const session = sessions.get(capturedSessionId);
        expect(session).not.toBeNull();
        const authz = authorizeCommand(session!, "status", { roles, roleVersions, workspaces }, lookup!.scope_json);
        expect(authz.ok).toBe(true);

        // "whoami" (tag:read) — also in manager allow-list → allowed.
        const whoami = authorizeCommand(session!, "whoami", { roles, roleVersions, workspaces }, lookup!.scope_json);
        expect(whoami.ok).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("Part B: baked scope is consulted — a restricted baked scope refuses commands outside it", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-scope-b-repo-"));
    try {
      const db = createDatabase(":memory:");
      const workspaces = createWorkspaceStore(db);
      const ws = workspaces.create({ name: "baked-ws", repo_path: repoPath });
      seedWorkspaceRoles(db, ws.id);
      const roles = createRoleStore(db);
      const managerRole = roles.findInWorkspace(ws.id, "manager");
      if (managerRole === null) throw new Error("manager role not seeded");
      const agents = createAgentStore(db);
      const agent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
      const sessions = createSessionStore(db);
      const sessionId = randomUUID();
      sessions.create({
        id: sessionId,
        agent_id: agent.id,
        workspace_id: ws.id,
        role_id: managerRole.id,
        pid: 1,
      });
      const tokenStore = createSessionTokenStore(db);

      // Register a token with a deliberately restricted baked scope (read-only).
      // The manager role + permissive workspace would normally allow "status" (write),
      // but the baked scope pins only read verbs — proving it is actually used.
      const restrictedScope = JSON.stringify({ allow: ["whoami", "transcript", "agents", "reports", "roles.list", "roles.show", "roles.status", "roles.diff", "roles.upstream.diff", "roles.upstream.log", "self-skills.list"], deny: [] });
      const token = tokenStore.mint(sessionId, restrictedScope);

      const lookup = tokenStore.lookup(token);
      expect(lookup).not.toBeNull();
      expect(lookup!.scope_json).toBe(restrictedScope);

      const session = sessions.get(sessionId);
      expect(session).not.toBeNull();
      const roleVersions = createRoleVersionStore(db);

      // whoami is in the baked scope → allowed.
      const whoami = authorizeCommand(session!, "whoami", { roles, roleVersions, workspaces }, lookup!.scope_json);
      expect(whoami.ok).toBe(true);

      // status is NOT in the baked scope — even though role+workspace would permit it
      // without a baked scope. Proves the baked path is consulted, not bypassed.
      const status = authorizeCommand(session!, "status", { roles, roleVersions, workspaces }, lookup!.scope_json);
      expect(status.ok).toBe(false);
      expect((status as { ok: false; status: number; error: string }).status).toBe(403);

      db.close();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("Part C: fresh-baked token has scope_json matching ws∩role materialization", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-scope-c-repo-"));
    try {
      const db = createDatabase(":memory:");
      const workspaces = createWorkspaceStore(db);
      const ws = workspaces.create({ name: "fresh-ws", repo_path: repoPath });
      seedWorkspaceRoles(db, ws.id);
      const roles = createRoleStore(db);
      const managerRole = roles.findInWorkspace(ws.id, "manager");
      if (managerRole === null) throw new Error("manager role not seeded");
      const roleVersions = createRoleVersionStore(db);
      const agents = createAgentStore(db);
      const agent = agents.create({ workspace_id: ws.id, role_id: managerRole.id });
      const sessions = createSessionStore(db);
      const sessionId = randomUUID();
      sessions.create({
        id: sessionId,
        agent_id: agent.id,
        workspace_id: ws.id,
        role_id: managerRole.id,
        pid: 1,
      });
      const tokenStore = createSessionTokenStore(db);

      // Compute the expected bake: ws (permissive ["*"]) ∩ role (["*"] for manager).
      // manager's allowed_cli_commands_json is ["*"] so baked = all capability names.
      const roleVersion = roleVersions.latestForRole(managerRole.id);
      expect(roleVersion).not.toBeNull();
      const roleAllowList = JSON.parse(roleVersion!.allowed_cli_commands_json) as readonly string[];
      const roleScope = { allow: roleAllowList as string[], deny: [] as string[] };
      const agentScope = { allow: ["*"], deny: [] as string[] };
      const bakedAllow = allCapabilityNames().filter(
        (v) => isActionAllowed(ws.perms_scope, v) && isActionAllowed(roleScope, v) && isActionAllowed(agentScope, v),
      );
      const bakedScopeJson = JSON.stringify({ allow: bakedAllow, deny: [] });

      const token = tokenStore.mint(sessionId, bakedScopeJson);
      const lookup = tokenStore.lookup(token);
      expect(lookup).not.toBeNull();
      // The stored scope matches the computed bake.
      expect(JSON.parse(lookup!.scope_json!)).toEqual(JSON.parse(bakedScopeJson));

      // Commands in the baked scope authorize correctly.
      const session = sessions.get(sessionId);
      expect(session).not.toBeNull();
      const authz = authorizeCommand(session!, "status", { roles, roleVersions, workspaces }, lookup!.scope_json);
      expect(authz.ok).toBe(true);

      db.close();
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
