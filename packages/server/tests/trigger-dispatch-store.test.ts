import { describe, it, expect } from "bun:test";
import { createDatabase } from "../src/db.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function bootstrapWorkspaceAndAgent(db: ReturnType<typeof createDatabase>): {
  workspaceId: string;
  roleId: string;
  agentId: string;
} {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-trigger-dispatch-store-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const workspaces = createWorkspaceStore(db);
  const agents = createAgentStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id });
  return { workspaceId: ws.id, roleId: roleRow.id, agentId: agent.id };
}

describe("trigger-dispatch-store", () => {
  it("appends a dispatched row and reads it back via listForAgent", () => {
    const db = createDatabase(":memory:");
    const ctx = bootstrapWorkspaceAndAgent(db);
    const store = createTriggerDispatchStore(db);

    const id = store.append({
      workspace_id: ctx.workspaceId,
      role_id: ctx.roleId,
      agent_id: ctx.agentId,
      trigger_kind: "cron",
      trigger_payload: { kind: "cron", expr: "0 9 * * *" },
      fired_at: 1_700_000_000_000,
      dispatch_outcome: "spawned",
    });
    expect(typeof id).toBe("number");

    const rows = store.listForAgent(ctx.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_kind).toBe("cron");
    expect(rows[0]!.trigger_payload).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(rows[0]!.dispatch_outcome).toBe("spawned");
    expect(rows[0]!.session_id).toBeUndefined();
    db.close();
  });

  it("listForAgent returns rows newest-first", () => {
    const db = createDatabase(":memory:");
    const ctx = bootstrapWorkspaceAndAgent(db);
    const store = createTriggerDispatchStore(db);

    store.append({
      workspace_id: ctx.workspaceId,
      role_id: ctx.roleId,
      agent_id: ctx.agentId,
      trigger_kind: "cron",
      trigger_payload: { kind: "cron", expr: "0 9 * * *" },
      fired_at: 1_700_000_000_000,
      dispatch_outcome: "spawned",
    });
    store.append({
      workspace_id: ctx.workspaceId,
      role_id: ctx.roleId,
      agent_id: ctx.agentId,
      trigger_kind: "cron",
      trigger_payload: { kind: "cron", expr: "0 9 * * *" },
      fired_at: 1_700_000_001_000,
      dispatch_outcome: "injected",
    });
    const rows = store.listForAgent(ctx.agentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.fired_at).toBe(1_700_000_001_000);
    expect(rows[1]!.fired_at).toBe(1_700_000_000_000);
    db.close();
  });

  it("records error and skipped outcome", () => {
    const db = createDatabase(":memory:");
    const ctx = bootstrapWorkspaceAndAgent(db);
    const store = createTriggerDispatchStore(db);

    store.append({
      workspace_id: ctx.workspaceId,
      role_id: ctx.roleId,
      agent_id: ctx.agentId,
      trigger_kind: "cron",
      trigger_payload: { kind: "cron", expr: "0 9 * * *" },
      fired_at: 1_700_000_000_000,
      dispatch_outcome: "skipped-busy",
    });
    store.append({
      workspace_id: ctx.workspaceId,
      role_id: ctx.roleId,
      agent_id: ctx.agentId,
      trigger_kind: "cron",
      trigger_payload: { kind: "cron", expr: "0 9 * * *" },
      fired_at: 1_700_000_001_000,
      dispatch_outcome: "errored",
      error: "spawn failed",
    });
    const rows = store.listForAgent(ctx.agentId);
    expect(rows[0]!.dispatch_outcome).toBe("errored");
    expect(rows[0]!.error).toBe("spawn failed");
    expect(rows[1]!.dispatch_outcome).toBe("skipped-busy");
    db.close();
  });
});
