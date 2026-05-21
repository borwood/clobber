import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { registerWorkspaceRoutes } from "../src/routes/workspaces.ts";
import {
  DEFAULT_SETTING_SOURCES,
  DEFAULT_WAKE_PROMPT,
  DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS,
  DEFAULT_TRIGGER_OVERRIDES,
  type Workspace,
} from "@clobber/shared";

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDatabase>;
let repoPath: string;

beforeEach(async () => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-wsconfig-"));
  mkdirSync(join(repoPath, ".git"));
  db = createDatabase(":memory:");
  app = Fastify({ logger: false });
  registerWorkspaceRoutes(app, { db, workspaces: createWorkspaceStore(db) });
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

describe("workspace wake_prompt — defaults + creation", () => {
  it("new workspaces default to the canonical wake prompt", async () => {
    const ws = await createWorkspace({});
    expect(ws.wake_prompt).toBe(DEFAULT_WAKE_PROMPT);
  });

  it("accepts a custom wake_prompt on creation", async () => {
    const ws = await createWorkspace({ wake_prompt: "wake up, neo" });
    expect(ws.wake_prompt).toBe("wake up, neo");
  });

  it("rejects empty wake_prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "ws", repo_path: repoPath, wake_prompt: "" },
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

describe("PATCH /workspaces/:id — updating wake_prompt and role_edit_policy", () => {
  it("PATCH wake_prompt updates the workspace", async () => {
    const ws = await createWorkspace({});
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}`,
      payload: { wake_prompt: "new wake prompt" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Workspace;
    expect(updated.wake_prompt).toBe("new wake prompt");
    expect(updated.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
  });

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
    expect(updated.wake_prompt).toBe(DEFAULT_WAKE_PROMPT);
    expect(updated.role_edit_policy).toEqual({
      forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
    });
    expect(updated.setting_sources).toEqual([...DEFAULT_SETTING_SOURCES]);
  });
});
