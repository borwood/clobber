import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, teardown, turnProvider } from "./_spawn-harness.ts";

// #210 — durable framing (layer A identity + relocated workspace/office
// context) is composed into the system prompt; the opening user message
// carries only the task kick.
describe("system-prompt composition (A/B/C)", () => {
  it("relocates workspace context + office continuity into the system prompt; the user turn is just the task kick", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({
      name: "ws",
      repo_path: h.repoPath,
      boot_context_provider: {
        kind: "exec",
        command: "sh",
        args: ["-c", "printf 'DURABLE-FRAMING'"],
      },
    });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    // A note from a prior session — office continuity.
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
    // Layer B — relocated workspace context + office continuity.
    expect(system).toContain("[Workspace context]");
    expect(system).toContain("DURABLE-FRAMING");
    expect(system).toContain("[Previously in this office]");
    // A precedes the relocated B seeds.
    expect(system.indexOf("You are the **Manager**")).toBeLessThan(
      system.indexOf("[Workspace context]"),
    );

    // The opening user message is only the task kick — durable framing no
    // longer rides it.
    expect(req.prompt).toBe("ship the issue");
    expect(req.prompt).not.toContain("[Workspace context]");
    expect(req.prompt).not.toContain("DURABLE-FRAMING");
    expect(req.prompt).not.toContain("[Previously in this office]");

    await h.records[0]!.exit(0);
    await teardown(h);
  });
});
