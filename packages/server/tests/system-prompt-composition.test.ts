import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, teardown, turnProvider, type Harness } from "./_spawn-harness.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { writeRoleVersion } from "./_role-version-fixture.ts";

// #210 — durable framing (layer A identity + relocated layer-B context) is
// composed into the system prompt; the opening user message carries only the
// task kick. Layer-B content now arrives via a prompt-module (#211) rather
// than the retired workspace boot-context provider.
describe("system-prompt composition (A/B/C)", () => {
  it("composes layer-A framing + layer-B prompt-module + office continuity into the system prompt; the user turn is just the task kick", async () => {
    const h = buildHarness(turnProvider());
    const modDir = join(h.repoPath, ".clobber", "prompt-modules", "framing-probe");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(modDir, "prompt-module.json"),
      JSON.stringify({ kind: "static", text: "DURABLE-FRAMING" }),
    );
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);
    refModule(h, role.id, "framing-probe");

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "ship the issue", label: "boot" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.records).toHaveLength(1);
    const req = h.records[0]!.req;

    const system = req.appendSystemPrompt!;
    // Layer A — role-unique identity header rides the system prompt.
    expect(system).toContain("You are the **Manager**");
    // Layer B — the prompt-module's text + instance-specific office continuity.
    expect(system).toContain("DURABLE-FRAMING");
    expect(system).toContain("[Previously in this office]");
    // A precedes the layer-B prompt-module.
    expect(system.indexOf("You are the **Manager**")).toBeLessThan(
      system.indexOf("DURABLE-FRAMING"),
    );

    // The opening user message is only the task kick — durable framing no
    // longer rides it.
    expect(req.prompt).toBe("ship the issue");
    expect(req.prompt).not.toContain("DURABLE-FRAMING");
    expect(req.prompt).not.toContain("[Previously in this office]");

    await h.records[0]!.exit(0);
    await teardown(h);
  });
});

// Make the role reference one prompt-module by name (replacing its default refs)
// so the composition under test is isolated to that module.
function refModule(h: Harness, roleId: string, name: string): void {
  const versions = createRoleVersionStore(h.db);
  const role = h.roles.get(roleId)!;
  const current = versions.get(role.current_version_id!)!;
  writeRoleVersion(h.db, role, current, { promptModuleRefs: [{ name, enabled: true }] });
}
