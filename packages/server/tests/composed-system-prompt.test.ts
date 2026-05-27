import { describe, expect, it } from "bun:test";
import { buildHarness, teardown, turnProvider } from "./_spawn-harness.ts";

// #253 — the clobber-composed `appendSystemPrompt` is captured on the session
// row at spawn and surfaced as a leading transcript pseudo-line so the audit
// view can show exactly what the agent was told on each wake.

describe("composed system prompt capture (#253)", () => {
  it("persists the composed appendSystemPrompt on the session row at spawn", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do the thing", label: "w1" },
    });
    expect(res.statusCode).toBe(200);
    const { session_id } = res.json() as { session_id: string };

    const composed = h.records[0]!.req.appendSystemPrompt;
    expect(typeof composed).toBe("string");
    expect(composed!.length).toBeGreaterThan(0);

    const session = h.sessions.get(session_id)!;
    expect(session.composed_system_prompt).toBe(composed!);

    await h.records[0]!.exit(0);
    await teardown(h);
  });

  it("serves the composed prompt as the leading system-prompt transcript line", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do the thing", label: "w1" },
    });
    const { session_id } = res.json() as { session_id: string };
    const composed = h.records[0]!.req.appendSystemPrompt!;

    const transcript = await h.server.inject({
      method: "GET",
      url: `/sessions/${session_id}/transcript`,
    });
    expect(transcript.statusCode).toBe(200);
    const lines = transcript.json() as Array<Record<string, unknown>>;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!["type"]).toBe("system-prompt");
    expect(lines[0]!["prompt"]).toBe(composed);

    await h.records[0]!.exit(0);
    await teardown(h);
  });

  it("re-captures the composed prompt on resume so the row reflects the latest wake", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const spawn = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "first", label: "boot" },
    });
    const { session_id } = spawn.json() as { session_id: string };
    await h.records[0]!.exit(0);

    const resume = await h.server.inject({
      method: "POST",
      url: `/sessions/${session_id}/prompt`,
      payload: { prompt: "second" },
    });
    expect(resume.statusCode).toBe(200);

    const reComposed = h.records[1]!.req.appendSystemPrompt!;
    const session = h.sessions.get(session_id)!;
    expect(session.composed_system_prompt).toBe(reComposed);

    await h.records[1]!.exit(0);
    await teardown(h);
  });
});
