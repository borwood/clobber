import { describe, expect, it } from "bun:test";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { createRoleContractRefusalStore } from "../src/role-contract-refusal-store.ts";
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

  it("mismatched stamp, no migrator → refuse-with-signal; spawn does not proceed", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // Stamp the version with a contract version that does not match the engine's
    // and that the empty v1 migrator cannot bridge. `contract_version` must be a
    // positive integer (RoleVersionSchema), and the engine ships contract v1, so
    // the only schema-valid mismatch to inject is a higher stamp — a version
    // authored against a contract the running engine does not know. The gate
    // refuses any unmigratable mismatch.
    const versionId = role.current_version_id!;
    const mismatchedContract = ENGINE_CONTRACT_VERSION + 1;
    h.db
      .prepare("UPDATE role_versions SET contract_version = ? WHERE id = ?")
      .run(mismatchedContract, versionId);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "go", label: "w" },
    });

    // Refuse-with-signal: the spawn is refused with a cause-naming 409, never
    // silently proceeding.
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: string;
      role: string;
      role_version_id: string;
      authored_contract_version: number;
      engine_contract_version: number;
    };
    expect(body.error).toBe("role-contract-incompatible");
    expect(body.role).toBe("worker");
    expect(body.role_version_id).toBe(versionId);
    expect(body.authored_contract_version).toBe(mismatchedContract);
    expect(body.engine_contract_version).toBe(ENGINE_CONTRACT_VERSION);

    // No OS process was started, and no session was created.
    expect(h.records).toHaveLength(0);
    expect(h.sessions.listForWorkspace(ws.id)).toHaveLength(0);

    // A durable, cause-naming refusal row is recorded for the manager to triage.
    const refusals = createRoleContractRefusalStore(h.db).listForWorkspace(ws.id);
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(refusal.role_name).toBe("worker");
    expect(refusal.role_id).toBe(role.id);
    expect(refusal.role_version_id).toBe(versionId);
    expect(refusal.authored_contract_version).toBe(mismatchedContract);
    expect(refusal.engine_contract_version).toBe(ENGINE_CONTRACT_VERSION);

    await teardown(h);
  });
});
