import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptModuleDefinition, PromptModuleRef } from "@clobber/shared";
import { buildHarness, teardown, turnProvider, type Harness } from "./_spawn-harness.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { writeRoleVersion } from "./_role-version-fixture.ts";

// #211 — layer B is a real seed subsystem: role-scoped, ordered, per-seed
// toggleable references resolving against a workspace seed catalog. A static
// seed composes its stored text; a dynamic seed composes its script stdout
// with the spawn env present. Default refs route the wisdom-pointer to the
// manager alone.

function authorSeed(repoPath: string, name: string, definition: PromptModuleDefinition): void {
  const dir = join(repoPath, ".clobber", "prompt-modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt-module.json"), JSON.stringify(definition));
}

function setPromptModuleRefs(h: Harness, roleId: string, refs: readonly PromptModuleRef[]): void {
  const versions = createRoleVersionStore(h.db);
  const role = h.roles.get(roleId)!;
  const current = versions.get(role.current_version_id!)!;
  writeRoleVersion(h.db, role, current, { promptModuleRefs: refs });
}

async function spawnAndReadSystem(h: Harness, roleId: string): Promise<string> {
  const ws = h.workspaces.create({
    name: `ws-${roleId.slice(0, 8)}-${h.records.length}`,
    repo_path: h.repoPath,
  });
  h.workspaceRoles.setCeiling(ws.id, roleId, 1);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: roleId, prompt: "go", label: "task" },
  });
  expect(res.statusCode).toBe(200);
  const rec = h.records[h.records.length - 1]!;
  const system = rec.req.appendSystemPrompt!;
  await rec.exit(0);
  return system;
}

describe("spawn — layer-B seed subsystem (#211)", () => {
  it("a static seed composes its stored text into the system prompt (layer B)", async () => {
    const h = buildHarness(turnProvider());
    authorSeed(h.repoPath, "welcome", { kind: "static", text: "STATIC-SEED-BODY" });
    const role = h.roles.create({ name: "worker", persistent: false });
    setPromptModuleRefs(h, role.id, [{ name: "welcome", enabled: true }]);

    const system = await spawnAndReadSystem(h, role.id);
    expect(system).toContain("STATIC-SEED-BODY");
    await teardown(h);
  });

  it("a dynamic seed composes its script stdout with the spawn env present", async () => {
    const h = buildHarness(turnProvider());
    authorSeed(h.repoPath, "env-probe", {
      kind: "dynamic",
      provider: {
        kind: "exec",
        command: "sh",
        args: ["-c", 'echo "PROBE ROLE=$CLOBBER_ROLE REPO=$CLOBBER_REPO_PATH"'],
      },
    });
    const role = h.roles.create({ name: "worker", persistent: false });
    setPromptModuleRefs(h, role.id, [{ name: "env-probe", enabled: true }]);

    const system = await spawnAndReadSystem(h, role.id);
    expect(system).toContain("PROBE ROLE=worker");
    expect(system).toContain(`REPO=${h.repoPath}`);
    await teardown(h);
  });

  it("seeds compose in ref order and a disabled ref drops out", async () => {
    const h = buildHarness(turnProvider());
    authorSeed(h.repoPath, "aaa", { kind: "static", text: "SEED-AAA" });
    authorSeed(h.repoPath, "bbb", { kind: "static", text: "SEED-BBB" });
    const role = h.roles.create({ name: "worker", persistent: false });

    // Order follows the ref list, not the seed name: bbb before aaa.
    setPromptModuleRefs(h, role.id, [
      { name: "bbb", enabled: true },
      { name: "aaa", enabled: true },
    ]);
    let system = await spawnAndReadSystem(h, role.id);
    expect(system.indexOf("SEED-BBB")).toBeLessThan(system.indexOf("SEED-AAA"));

    // Disable aaa — it drops out; bbb stays.
    setPromptModuleRefs(h, role.id, [
      { name: "bbb", enabled: true },
      { name: "aaa", enabled: false },
    ]);
    system = await spawnAndReadSystem(h, role.id);
    expect(system).toContain("SEED-BBB");
    expect(system).not.toContain("SEED-AAA");
    await teardown(h);
  });

  it("the wisdom-pointer default seed reaches the manager but not the worker", async () => {
    const h = buildHarness(turnProvider());
    const manager = h.roles.create({ name: "manager", persistent: true });
    const worker = h.roles.create({ name: "worker", persistent: false });

    const managerSystem = await spawnAndReadSystem(h, manager.id);
    expect(managerSystem).toContain("brennan-volter/tasks#20");

    const workerSystem = await spawnAndReadSystem(h, worker.id);
    expect(workerSystem).not.toContain("brennan-volter/tasks#20");
    await teardown(h);
  });
});
