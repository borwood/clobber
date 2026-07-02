import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { EffortLevel, Model } from "@clobber/shared";
import { buildHarness, turnProvider, type Harness } from "./_spawn-harness.ts";

interface ControlLine {
  type: string;
  request_id: string;
  request: { subtype: string; model?: string; settings?: Record<string, unknown> };
}

function controlLines(h: Harness, recordIndex: number): ControlLine[] {
  const record = h.records[recordIndex];
  if (record === undefined) throw new Error(`no spawn record at ${recordIndex}`);
  return record.stdinChunks
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ControlLine)
    .filter((l) => l.type === "control_request");
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-session-reconfigure-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function spawnSession(
  h: Harness,
  opts?: { readonly roleModel?: Model; readonly roleEffort?: EffortLevel; readonly model?: Model; readonly effort?: EffortLevel },
): Promise<string> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({
    name: "worker",
    persistent: false,
    ...(opts?.roleModel === undefined ? {} : { model: opts.roleModel }),
    ...(opts?.roleEffort === undefined ? {} : { effort: opts.roleEffort }),
  });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: {
      workspace_id: ws.id,
      role_id: role.id,
      prompt: "do something",
      label: "test-worker",
      ...(opts?.model === undefined ? {} : { model: opts.model }),
      ...(opts?.effort === undefined ? {} : { effort: opts.effort }),
    },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { session_id: string }).session_id;
}

describe("POST /sessions/:id/config", () => {
  it("writes set_model + effort control requests to a live session and records the fact", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const sessionId = await spawnSession(h, { roleModel: "opus", roleEffort: "high" });

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/config`,
      payload: { model: "sonnet", effort: "low" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as Record<string, unknown>).toEqual({ ok: true, applied: "live" });

    const controls = controlLines(h, 0);
    const setModel = controls.find((c) => c.request.subtype === "set_model");
    expect(setModel).toBeDefined();
    expect(setModel!.request.model).toBe("sonnet");
    expect(setModel!.request_id.length).toBeGreaterThan(0);
    const setEffort = controls.find((c) => c.request.subtype === "apply_flag_settings");
    expect(setEffort).toBeDefined();
    expect(setEffort!.request.settings).toEqual({ effort: "low" });

    const session = h.sessions.get(sessionId);
    expect(session!.model).toBe("sonnet");
    expect(session!.effort).toBe("low");
    expect(session!.model_override).toBe("sonnet");
    expect(session!.effort_override).toBe("low");
    await h.server.close();
    h.db.close();
  });

  it("changes only the supplied dial, leaving the other untouched", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const sessionId = await spawnSession(h, { roleModel: "opus", roleEffort: "high" });

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/config`,
      payload: { model: "haiku" },
    });
    expect(res.statusCode).toBe(200);

    const controls = controlLines(h, 0);
    expect(controls.some((c) => c.request.subtype === "set_model")).toBe(true);
    expect(controls.some((c) => c.request.subtype === "apply_flag_settings")).toBe(false);

    const session = h.sessions.get(sessionId);
    expect(session!.model).toBe("haiku");
    expect(session!.effort).toBe("high");
    expect(session!.model_override).toBe("haiku");
    expect(session!.effort_override).toBeUndefined();
    await h.server.close();
    h.db.close();
  });

  it("records the dial on an ended session without control writes; resume applies it", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const sessionId = await spawnSession(h, { roleModel: "opus" });
    await h.records[0]!.exit(0);

    const before = controlLines(h, 0).length;
    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/config`,
      payload: { model: "sonnet" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as Record<string, unknown>).toEqual({ ok: true, applied: "deferred" });
    expect(controlLines(h, 0).length).toBe(before);

    const session = h.sessions.get(sessionId);
    expect(session!.model_override).toBe("sonnet");

    const resume = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/resume`,
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    expect(h.records[1]!.req.model).toBe("sonnet");
    expect(h.sessions.get(sessionId)!.model).toBe("sonnet");
    await h.server.close();
    h.db.close();
  });

  it("spawn-time overrides survive resume; underived role defaults still re-derive", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const sessionId = await spawnSession(h, {
      roleModel: "opus",
      roleEffort: "high",
      model: "sonnet",
    });
    expect(h.records[0]!.req.model).toBe("sonnet");
    expect(h.sessions.get(sessionId)!.model_override).toBe("sonnet");

    await h.records[0]!.exit(0);
    const resume = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/resume`,
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    // The explicit dial survives; effort had no override so the role default applies.
    expect(h.records[1]!.req.model).toBe("sonnet");
    expect(h.records[1]!.req.effort).toBe("high");
    await h.server.close();
    h.db.close();
  });

  it("defers on a live session whose runtime lacks the reconfigure capability", async () => {
    const h = buildHarness(turnProvider());
    const sessionId = await spawnSession(h, { roleModel: "opus" });

    const res = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/config`,
      payload: { model: "sonnet" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as Record<string, unknown>).toEqual({ ok: true, applied: "deferred" });
    expect(controlLines(h, 0).length).toBe(0);
    expect(h.sessions.get(sessionId)!.model_override).toBe("sonnet");
    await h.server.close();
    h.db.close();
  });

  it("rejects an empty change and an unknown session", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const sessionId = await spawnSession(h);

    const empty = await h.server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/config`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const missing = await h.server.inject({
      method: "POST",
      url: "/sessions/00000000-0000-0000-0000-000000000000/config",
      payload: { model: "sonnet" },
    });
    expect(missing.statusCode).toBe(404);
    await h.server.close();
    h.db.close();
  });
});
