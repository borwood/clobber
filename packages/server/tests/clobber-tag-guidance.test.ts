import { describe, expect, it } from "bun:test";
import { CLOBBER_TAG_INTERPRETATION_GUIDANCE } from "@clobber/shared";
import { buildHarness, teardown, turnProvider } from "./_spawn-harness.ts";

// #262 — every clobber spawn's composed system prompt teaches the agent how to
// interpret `<clobber type="…">` wrappers (added in #261). The guidance is
// composed at the layer-A seam so manager and worker both receive it without
// per-role prompt edits, and stays generic-over-type (meaning, not policy).
describe("clobber tag-interpretation guidance (#262)", () => {
  it("includes the tag-interpretation guidance in the composed prompt for a worker", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do it", label: "w" },
    });
    expect(res.statusCode).toBe(200);
    const composed = h.records[0]!.req.appendSystemPrompt!;
    expect(composed).toContain(CLOBBER_TAG_INTERPRETATION_GUIDANCE);

    await h.records[0]!.exit(0);
    await teardown(h);
  });

  it("includes the tag-interpretation guidance in the composed prompt for a manager", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "m" },
    });
    expect(res.statusCode).toBe(200);
    const composed = h.records[0]!.req.appendSystemPrompt!;
    expect(composed).toContain(CLOBBER_TAG_INTERPRETATION_GUIDANCE);

    await h.records[0]!.exit(0);
    await teardown(h);
  });

  it("guidance is generic-over-type — names the wrapper shape, not per-kind behavior", () => {
    // Must describe the wrapper itself.
    expect(CLOBBER_TAG_INTERPRETATION_GUIDANCE).toContain("<clobber");
    // Must not prescribe per-kind behavior. The enum members are concrete
    // hooks: if any of them appear, the guidance has drifted into policy.
    const perKindMembers = [
      "wake-kick",
      "ask-answer",
      "spawn-prompt",
      "live-inject",
      "interrupt-notice",
      "tool-token",
    ];
    for (const member of perKindMembers) {
      expect(CLOBBER_TAG_INTERPRETATION_GUIDANCE).not.toContain(`type="${member}"`);
    }
  });
});
