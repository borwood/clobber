import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { registerWorkspaceRoutes } from "../src/routes/workspaces.ts";
import type { TriggerScheduler } from "../src/trigger-scheduler.ts";
import {
  DEFAULT_SETTING_SOURCES,
  DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS,
  DEFAULT_TRIGGER_OVERRIDES,
  DEFAULT_FINAL_REPORT_CALLBACK,
  DEFAULT_MANAGER_SKILL_POLICY,
  type Workspace,
} from "@clobber/shared";

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDatabase>;
let repoPath: string;
let reloadedRoles: string[];

beforeEach(async () => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-wsconfig-"));
  mkdirSync(join(repoPath, ".git"));
  db = createDatabase(":memory:");
  app = Fastify({ logger: false });
  reloadedRoles = [];
  const scheduler: Pick<TriggerScheduler, "reloadRole" | "fireWorkspaceOpen"> = {
    reloadRole: (roleId) => {
      reloadedRoles.push(roleId);
    },
    fireWorkspaceOpen: async () => ({ dispatched: 0 }),
  };
  registerWorkspaceRoutes(app, {
    db,
    workspaces: createWorkspaceStore(db),
    scheduler,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(repoPath, { recursive: true, force: true });
});

async function createWorkspace(payload: Record<string, unknown>): Promise<Workspace> {
  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws", repo_path: repoPath, ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Workspace;
}

describe("workspace setting_sources — defaults + creation", () => {
  it("new workspaces default to user,project,local — vanilla claude behavior", async () => {
    const ws = await createWorkspace({});
    expect(ws.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
  });

  it("accepts a restricted setting_sources on creation", async () => {
    const ws = await createWorkspace({ setting_sources: ["user"] });
    expect(ws.setting_sources).toEqual(["user"]);
  });

  it("rejects unknown setting source values", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repoPath, setting_sources: ["bogus"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects duplicate setting sources", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repoPath, setting_sources: ["user", "user"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("workspace role_edit_policy — defaults + creation", () => {
  it("new workspaces default to forbidden_keys=[hooks, permission_mode]", async () => {
    const ws = await createWorkspace({});
    expect(ws.role_edit_policy).toEqual({
      forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
    });
  });

  it("accepts a custom role_edit_policy on creation", async () => {
    const ws = await createWorkspace({
      role_edit_policy: { forbidden_keys: ["permission_mode"] },
    });
    expect(ws.role_edit_policy).toEqual({ forbidden_keys: ["permission_mode"] });
  });

  it("accepts an empty forbidden_keys list (opens up all edits)", async () => {
    const ws = await createWorkspace({
      role_edit_policy: { forbidden_keys: [] },
    });
    expect(ws.role_edit_policy).toEqual({ forbidden_keys: [] });
  });
});

describe("PATCH /workspaces/:id — updating role_edit_policy", () => {
  it("PATCH role_edit_policy updates the workspace", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { role_edit_policy: { forbidden_keys: ["hooks"] } },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.role_edit_policy).toEqual({ forbidden_keys: ["hooks"] });
  });

  it("PATCH with no fields returns 400", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /workspaces/:id — updating setting_sources", () => {
  it("replaces the workspace's setting_sources and returns the updated row", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { setting_sources: ["user"] },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.setting_sources).toEqual(["user"]);
  });

  it("returns 404 for an unknown workspace id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/workspaces/00000000-0000-4000-8000-000000000000",
      payload: { setting_sources: ["user"] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unknown source values", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { setting_sources: ["user", "fake"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists the update — subsequent GET reflects the new value", async () => {
    const ws = await createWorkspace({});
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { setting_sources: ["user", "project"] },
    });
    const getRes = await app.inject({ method: "GET", url: `/workspaces/${ws.id}` });
    const refreshed = getRes.json() as Workspace;
    expect(refreshed.setting_sources).toEqual(["user", "project"]);
  });
});

describe("workspace trigger_overrides — defaults + creation", () => {
  it("new workspaces default to an empty trigger_overrides map (no triggers disabled)", async () => {
    const ws = await createWorkspace({});
    expect(ws.trigger_overrides).toEqual({ ...DEFAULT_TRIGGER_OVERRIDES });
  });

  it("accepts a custom trigger_overrides on creation", async () => {
    const roleId = "11111111-2222-4333-8444-555555555555";
    const ws = await createWorkspace({
      trigger_overrides: { [roleId]: { disabled_trigger_ids: ["cron:0 9 * * *"] } },
    });
    expect(ws.trigger_overrides).toEqual({
      [roleId]: { disabled_trigger_ids: ["cron:0 9 * * *"] },
    });
  });

  it("rejects duplicate disabled_trigger_ids", async () => {
    const roleId = "11111111-2222-4333-8444-555555555555";
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        trigger_overrides: {
          [roleId]: { disabled_trigger_ids: ["cron:0 9 * * *", "cron:0 9 * * *"] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-uuid role-instance key in the override map", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        trigger_overrides: {
          "not-a-uuid": { disabled_trigger_ids: ["cron:0 9 * * *"] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /workspaces/:id — updating trigger_overrides", () => {
  it("PATCH trigger_overrides round-trips: enable → disable → re-enable", async () => {
    const ws = await createWorkspace({});
    const roleId = "11111111-2222-4333-8444-555555555555";

    // Disable
    const disableRes = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        trigger_overrides: { [roleId]: { disabled_trigger_ids: ["cron:0 9 * * *"] } },
      },
    });
    expect(disableRes.statusCode).toBe(200);
    expect((disableRes.json() as Workspace).trigger_overrides).toEqual({
      [roleId]: { disabled_trigger_ids: ["cron:0 9 * * *"] },
    });

    // Re-enable (clear the override map)
    const enableRes = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { trigger_overrides: {} },
    });
    expect(enableRes.statusCode).toBe(200);
    expect((enableRes.json() as Workspace).trigger_overrides).toEqual({});

    // GET reflects the cleared map
    const getRes = await app.inject({ method: "GET", url: `/workspaces/${ws.id}` });
    expect((getRes.json() as Workspace).trigger_overrides).toEqual({});
  });

  it("PATCH trigger_overrides reloads the scheduler for each role in the override map", async () => {
    const ws = await createWorkspace({});
    const roleA = "11111111-2222-4333-8444-555555555555";
    const roleB = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    reloadedRoles.length = 0;
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        trigger_overrides: {
          [roleA]: { disabled_trigger_ids: ["cron:0 9 * * *"] },
          [roleB]: { disabled_trigger_ids: ["webhook:/h/x"] },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(reloadedRoles.sort()).toEqual([roleA, roleB].sort());
  });

  it("PATCH setting_sources alone does not reload the scheduler", async () => {
    const ws = await createWorkspace({});
    reloadedRoles.length = 0;
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { setting_sources: ["user"] },
    });
    expect(reloadedRoles).toEqual([]);
  });

  it("PATCH trigger_overrides leaves other fields untouched", async () => {
    const ws = await createWorkspace({});
    const roleId = "11111111-2222-4333-8444-555555555555";
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        trigger_overrides: { [roleId]: { disabled_trigger_ids: ["webhook:/h/x"] } },
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.role_edit_policy).toEqual({
      forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
    });
    expect(updated.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
  });
});

describe("workspace final_report_callback — defaults + creation", () => {
  it("new workspaces default to noop", async () => {
    const ws = await createWorkspace({});
    expect(ws.final_report_callback).toEqual({ ...DEFAULT_FINAL_REPORT_CALLBACK });
  });

  it("accepts an exec callback on creation", async () => {
    const ws = await createWorkspace({
      final_report_callback: {
        kind: "exec",
        command: "gh",
        args: ["issue", "create", "--repo", "owner/repo"],
      },
    });
    expect(ws.final_report_callback).toEqual({
      kind: "exec",
      command: "gh",
      args: ["issue", "create", "--repo", "owner/repo"],
    });
  });

  it("accepts an http callback on creation", async () => {
    const ws = await createWorkspace({
      final_report_callback: {
        kind: "http",
        url: "https://hooks.example.test/intake",
        headers: { "x-token": "abc" },
      },
    });
    expect(ws.final_report_callback).toEqual({
      kind: "http",
      url: "https://hooks.example.test/intake",
      headers: { "x-token": "abc" },
    });
  });

  it("rejects an unknown callback kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        final_report_callback: { kind: "telepathy" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an exec callback with empty command", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        final_report_callback: { kind: "exec", command: "" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an http callback with an invalid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        final_report_callback: { kind: "http", url: "not-a-url" },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /workspaces/:id — updating final_report_callback", () => {
  it("PATCH final_report_callback round-trips: noop → exec → noop", async () => {
    const ws = await createWorkspace({});
    const setExec = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        final_report_callback: { kind: "exec", command: "true" },
      },
    });
    expect(setExec.statusCode).toBe(200);
    expect((setExec.json() as Workspace).final_report_callback).toEqual({
      kind: "exec",
      command: "true",
    });
    const back = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { final_report_callback: { kind: "noop" } },
    });
    expect(back.statusCode).toBe(200);
    expect((back.json() as Workspace).final_report_callback).toEqual({ kind: "noop" });
  });

  it("PATCH final_report_callback alone does not reload the trigger scheduler", async () => {
    const ws = await createWorkspace({});
    reloadedRoles.length = 0;
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        final_report_callback: { kind: "http", url: "https://x.test/h" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(reloadedRoles).toEqual([]);
  });

  it("PATCH final_report_callback leaves other config fields untouched", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        final_report_callback: { kind: "exec", command: "echo" },
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
    expect(updated.role_edit_policy).toEqual({
      forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
    });
    expect(updated.trigger_overrides).toEqual({ ...DEFAULT_TRIGGER_OVERRIDES });
  });
});

describe("workspace manager_skill_policy — defaults + creation", () => {
  it("new workspaces default to allow_self_grant=false, empty allowed_skills", async () => {
    const ws = await createWorkspace({});
    expect(ws.manager_skill_policy).toEqual({
      allow_self_grant: DEFAULT_MANAGER_SKILL_POLICY.allow_self_grant,
      allowed_skills: [...DEFAULT_MANAGER_SKILL_POLICY.allowed_skills],
    });
  });

  it("accepts a custom manager_skill_policy on creation", async () => {
    const ws = await createWorkspace({
      manager_skill_policy: {
        allow_self_grant: true,
        allowed_skills: ["clobber-pm", "audit-tickets"],
      },
    });
    expect(ws.manager_skill_policy).toEqual({
      allow_self_grant: true,
      allowed_skills: ["clobber-pm", "audit-tickets"],
    });
  });

  it("rejects duplicate allowed_skills", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {
        name: "ws",
        repo_path: repoPath,
        manager_skill_policy: {
          allow_self_grant: true,
          allowed_skills: ["a", "a"],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /workspaces/:id — updating manager_skill_policy", () => {
  it("PATCH manager_skill_policy round-trips: closed → open → closed", async () => {
    const ws = await createWorkspace({});
    const open = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        manager_skill_policy: {
          allow_self_grant: true,
          allowed_skills: ["clobber-pm"],
        },
      },
    });
    expect(open.statusCode).toBe(200);
    expect((open.json() as Workspace).manager_skill_policy).toEqual({
      allow_self_grant: true,
      allowed_skills: ["clobber-pm"],
    });

    const close = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        manager_skill_policy: { allow_self_grant: false, allowed_skills: [] },
      },
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as Workspace).manager_skill_policy).toEqual({
      allow_self_grant: false,
      allowed_skills: [],
    });
  });

  it("PATCH manager_skill_policy alone does not reload the trigger scheduler", async () => {
    const ws = await createWorkspace({});
    reloadedRoles.length = 0;
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        manager_skill_policy: {
          allow_self_grant: true,
          allowed_skills: ["clobber-pm"],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(reloadedRoles).toEqual([]);
  });

  it("PATCH manager_skill_policy leaves other config fields untouched", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: {
        manager_skill_policy: { allow_self_grant: true, allowed_skills: ["x"] },
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
    expect(updated.role_edit_policy).toEqual({
      forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
    });
    expect(updated.trigger_overrides).toEqual({ ...DEFAULT_TRIGGER_OVERRIDES });
    expect(updated.final_report_callback).toEqual({ ...DEFAULT_FINAL_REPORT_CALLBACK });
  });
});
