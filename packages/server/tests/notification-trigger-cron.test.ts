import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleTrigger } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import { defaultSynthesizePrompt } from "../src/trigger-synthesize.ts";
import { dispatchTrigger, type AgentBinding, type DispatchDeps } from "../src/trigger-dispatch.ts";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";

function makeCronHarness(): {
  deps: DispatchDeps;
  binding: AgentBinding;
  notifications: ReturnType<typeof createNotificationStore>;
} {
  const db = createDatabase(":memory:");
  const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const dispatches = createTriggerDispatchStore(db);
  const notifications = createNotificationStore(db);
  const dispatcher = createNotificationDispatcher(notifications, clock);

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-cron-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr" });

  let spawnN = 0;
  const attach: AttachSessionFn = async (_input): Promise<AttachOutcome> => {
    spawnN++;
    const sessionId = `manager-session-${spawnN}`;
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 4000 + spawnN,
    });
    return { ok: true, agent_id: agent.id, session_id: sessionId, pid: 4000 + spawnN };
  };

  const deps: DispatchDeps = {
    clock,
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    dispatches,
    attachSession: attach,
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
    synthesize: defaultSynthesizePrompt,
    dispatcher,
  };

  return {
    deps,
    binding: { agentId: agent.id, roleId: roleRow.id, workspaceId: ws.id },
    notifications,
  };
}

// ─── Cron key honesty (#590) ──────────────────────────────────────────────────
// cron must NOT produce a source_id. Wall-clock firedAt is unique per dispatch
// call — "cron:${expr}:${firedAt}" looks like a dedup key but never actually
// dedups anything. Honest behaviour: return undefined so logical_key is NULL
// and each tick is always-inserted (the same no-dedup semantics cron already had,
// but without the misleading look-armed key).
describe("cron trigger dispatch — honest no-dedup (source_id is undefined)", () => {
  it("cron dispatch produces a notification with no source_id (null logical_key)", async () => {
    const h = makeCronHarness();
    const trigger: RoleTrigger = { kind: "cron", expr: "* 9 * * *" };

    await dispatchTrigger(h.deps, h.binding, trigger, undefined);

    const rows = h.notifications.listForAgent(h.binding.agentId);
    expect(rows).toHaveLength(1);
    // source_id must be absent — cron carries no stable occurrence identity
    expect(rows[0]!.provenance.source_id).toBeUndefined();
  });

  it("two cron dispatches produce two independent rows (no dedup, not collapsed)", async () => {
    const h = makeCronHarness();
    const trigger: RoleTrigger = { kind: "cron", expr: "* 9 * * *" };

    await dispatchTrigger(h.deps, h.binding, trigger, undefined);
    await dispatchTrigger(h.deps, h.binding, trigger, undefined);

    // Each cron tick is independent — must not be collapsed to 1 row
    expect(h.notifications.listForAgent(h.binding.agentId)).toHaveLength(2);
  });
});
