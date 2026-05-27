import { describe, expect, it } from "bun:test";
import type { WakeProgram } from "@clobber/shared";
import { buildHarness, teardown, turnProvider, type Harness } from "./_spawn-harness.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { editRole } from "../src/edit-role.ts";

// #212 — a wake-program is the opening move: it owns layer C (a system-prompt
// addon) and the opening user-message kick (or null for no kick). `idle` is the
// universal built-in: no C, no kick. The selected program is gated on SpawnMode
// — the kick fires on attach and is suppressed on resume, while layer C still
// composes on resume.

function setWakePrograms(h: Harness, roleId: string, programs: readonly WakeProgram[]): void {
  const versions = createRoleVersionStore(h.db);
  const role = h.roles.get(roleId)!;
  const current = versions.get(role.current_version_id!)!;
  editRole(h.db, role, current, { wakePrograms: programs });
}

async function spawnWith(
  h: Harness,
  roleId: string,
  wakeProgram: string,
): Promise<{ session: string; system: string; prompt: string | undefined }> {
  const ws = h.workspaces.create({
    name: `ws-${roleId.slice(0, 8)}-${h.records.length}`,
    repo_path: h.repoPath,
  });
  h.workspaceRoles.setCeiling(ws.id, roleId, 1);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: roleId, prompt: "manager free text", label: "task", wake_program: wakeProgram },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string };
  const rec = h.records[h.records.length - 1]!;
  return { session: body.session_id, system: rec.req.appendSystemPrompt!, prompt: rec.req.prompt };
}

describe("wake-programs (#212)", () => {
  it("a 'task' wake-program composes its system into layer C and emits its user kick", async () => {
    const h = buildHarness(turnProvider());
    const role = h.roles.create({ name: "worker", persistent: false });
    setWakePrograms(h, role.id, [
      { name: "task", system: "LAYER-C-TASK-ADDON", user: "Read your desk and begin." },
    ]);

    const { system, prompt } = await spawnWith(h, role.id, "task");
    // Layer C — the wake-program's system addon rides the system prompt.
    expect(system).toContain("LAYER-C-TASK-ADDON");
    // The opening user message is the wake-program's kick, not the caller's text.
    expect(prompt).toBe("Read your desk and begin.");
    expect(prompt).not.toContain("manager free text");
    await teardown(h);
  });

  it("'idle' (built-in) composes A+B only — no layer-C addon and no user turn", async () => {
    const h = buildHarness(turnProvider());
    const role = h.roles.create({ name: "worker", persistent: false });
    setWakePrograms(h, role.id, [
      { name: "task", system: "LAYER-C-TASK-ADDON", user: "Read your desk and begin." },
    ]);

    const { system, prompt } = await spawnWith(h, role.id, "idle");
    expect(system).not.toContain("LAYER-C-TASK-ADDON");
    // idle takes no opening turn.
    expect(prompt).toBeUndefined();
    await teardown(h);
  });

  it("selects the wake-program by name at spawn", async () => {
    const h = buildHarness(turnProvider());
    const role = h.roles.create({ name: "worker", persistent: false });
    setWakePrograms(h, role.id, [
      { name: "task", system: "C-FOR-TASK", user: "go-task" },
      { name: "triage", system: "C-FOR-TRIAGE", user: "go-triage" },
    ]);

    const task = await spawnWith(h, role.id, "task");
    expect(task.system).toContain("C-FOR-TASK");
    expect(task.system).not.toContain("C-FOR-TRIAGE");
    expect(task.prompt).toBe("go-task");

    const triage = await spawnWith(h, role.id, "triage");
    expect(triage.system).toContain("C-FOR-TRIAGE");
    expect(triage.system).not.toContain("C-FOR-TASK");
    expect(triage.prompt).toBe("go-triage");
    await teardown(h);
  });

  it("the shipped worker role's `task` program reads its desk; `idle` boots and waits", async () => {
    // Exercises the real lift: a worker created from its shipped manifest
    // snapshots the `task` wake-program. Spawned `task` it gets the desk
    // protocol (layer C); spawned `idle` it gets neither C nor a kick.
    const h = buildHarness(turnProvider());
    const role = h.roles.create({ name: "worker", persistent: false });

    const task = await spawnWith(h, role.id, "task");
    expect(task.system).toContain("read your desk");
    expect(task.system).toContain("$CLOBBER_DESK_DIR");
    expect(task.prompt).not.toBeUndefined();

    const idle = await spawnWith(h, role.id, "idle");
    expect(idle.system).not.toContain("$CLOBBER_DESK_DIR");
    expect(idle.prompt).toBeUndefined();
    await teardown(h);
  });

  it("on resume the kick is suppressed while layer C still composes", async () => {
    const h = buildHarness(turnProvider());
    const role = h.roles.create({ name: "worker", persistent: false });
    setWakePrograms(h, role.id, [
      { name: "task", system: "LAYER-C-TASK-ADDON", user: "Read your desk and begin." },
    ]);

    const attach = await spawnWith(h, role.id, "task");
    expect(attach.prompt).toBe("Read your desk and begin.");
    // Leave the turn-lifetime session live (clean exit, not ended).
    await h.records[h.records.length - 1]!.exit(0);

    const resumeRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${attach.session}/prompt`,
      payload: { prompt: "second turn" },
    });
    expect(resumeRes.statusCode).toBe(200);
    const resumeReq = h.records[h.records.length - 1]!.req;

    // Layer C still composes on resume...
    expect(resumeReq.appendSystemPrompt).toContain("LAYER-C-TASK-ADDON");
    // ...but the wake-program kick is suppressed — the turn carries only the
    // resume message, never the opening-move user template.
    expect(resumeReq.prompt).toBe("second turn");
    expect(resumeReq.prompt).not.toBe("Read your desk and begin.");
    await teardown(h);
  });
});
