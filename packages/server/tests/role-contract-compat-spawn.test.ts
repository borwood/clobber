import { describe, expect, it } from "bun:test";
import { buildHarness, teardown, turnProvider } from "./_spawn-harness.ts";

// #237 — the engine acts on the #236 contract stamp at the spawn boundary.
// Compatible role versions embody unchanged; a version authored under an older
// contract with no registered migration is refused-with-signal, never silently
// spawned against a contract that may no longer mean what it meant.
describe("role-version contract compatibility gate at spawn (#237)", () => {
  it("compatible stamp → spawn proceeds and a process is started", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // The freshly authored version is stamped at the engine's current contract
    // version → compatible → proceeds.
    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "w" },
    });

    expect(res.statusCode).toBe(200);
    expect(h.records).toHaveLength(1);

    await h.records[0]!.exit(0);
    await teardown(h);
  });

  // #491: the version-pinned contract gate is removed. Commit-pinned (git-backed)
  // roles are current by construction and always pass through spawn.

});
