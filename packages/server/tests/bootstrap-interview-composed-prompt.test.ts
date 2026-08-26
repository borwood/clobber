import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, teardown, turnProvider, type Harness } from "./_spawn-harness.ts";
import { writeRoleVersion } from "./_role-version-fixture.ts";

// #685 bootstrap-interview — AC3 (load-bearing) and AC4.
//
// AC3: the interview's write outputs are nothing more than the two existing
// overlay surfaces — a static prompt-module + a worker-role ref — so this
// proves the plumbing the skill relies on, not the skill's own prose. Once
// those two files exist, a freshly spawned worker's `composed_system_prompt`
// must carry the ratified text verbatim (spawn-context.ts:165 composes layer
// B fresh on every spawn).
//
// AC4: skip/abort must leave a working default workspace — a worker spawned
// with neither the module nor the sentinel present still boots clean on
// shipped defaults.

function authorProjectContextModule(repoPath: string, text: string): void {
  const dir = join(repoPath, ".clobber", "prompt-modules", "project-context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt-module.json"), JSON.stringify({ kind: "static", text }));
}

function writeSentinel(repoPath: string): void {
  const dir = join(repoPath, ".clobber");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bootstrap.json"), JSON.stringify({ done: true }));
}

// Appends the ref rather than replacing the shipped worker's default list —
// this mirrors what `clobber roles prompt-modules worker add project-context`
// actually does to the live ref list (it adds one entry, it doesn't clobber
// the role's other defaults).
function addProjectContextRef(h: Harness, roleId: string): void {
  const role = h.roles.get(roleId)!;
  const current = h.roleVersions.latestForRole(roleId)!;
  const existingRefs = JSON.parse(current.seed_refs_json) as Array<{
    name: string;
    enabled: boolean;
  }>;
  writeRoleVersion(h.db, role, current, {
    promptModuleRefs: [...existingRefs, { name: "project-context", enabled: true }],
  });
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
  const { session_id } = res.json() as { session_id: string };
  const rec = h.records[h.records.length - 1]!;
  const system = h.sessions.get(session_id)!.composed_system_prompt!;
  await rec.exit(0);
  return system;
}

describe("bootstrap-interview overlay reaches a spawned worker (#685)", () => {
  it("AC3 (load-bearing): a completed interview's ratified text reaches composed_system_prompt", async () => {
    const h = buildHarness(turnProvider());
    const RATIFIED = "RATIFIED-CONTEXT-MARKER: SDLC is research->ship, roles are manager+worker";
    authorProjectContextModule(h.repoPath, RATIFIED);
    const worker = h.roles.create({ name: "worker", persistent: false });
    addProjectContextRef(h, worker.id);
    writeSentinel(h.repoPath);

    const system = await spawnAndReadSystem(h, worker.id);
    expect(system).toContain(RATIFIED);

    await teardown(h);
  });

  it("AC4: a fresh workspace with no completed interview still spawns a worker on shipped defaults", async () => {
    const h = buildHarness(turnProvider());
    const worker = h.roles.create({ name: "worker", persistent: false });

    const system = await spawnAndReadSystem(h, worker.id);
    expect(system).not.toContain("RATIFIED-CONTEXT-MARKER");
    expect(system.length).toBeGreaterThan(0);

    await teardown(h);
  });
});
