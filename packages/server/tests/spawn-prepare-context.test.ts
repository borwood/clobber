import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { prepareSpawnContext } from "../src/spawn-context.ts";
import { buildHarness, teardown, turnProvider } from "./_spawn-harness.ts";

describe("prepareSpawnContext (#125) is the shared spawn/attach/resume seam", () => {
  it("is exported as a function from spawn-context.ts", () => {
    expect(typeof prepareSpawnContext).toBe("function");
  });

  it("spawn (attach) and resume share env/prompt/PATH layout, with documented asymmetries", async () => {
    const h = buildHarness(turnProvider());
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "manager", persistent: true });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const spawnRes = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "first turn", label: "boot" },
    });
    expect(spawnRes.statusCode).toBe(200);
    const spawnBody = spawnRes.json() as { session_id: string; pid: number };

    expect(h.records).toHaveLength(1);
    const attachReq = h.records[0]!.req;
    const attachEnv = attachReq.env;
    expect(attachEnv).toBeDefined();
    expect(attachEnv!["CLOBBER_API_BASE"]).toBe("http://test.invalid");
    expect(attachEnv!["CLOBBER_WORKSPACE_ID"]).toBe(ws.id);
    expect(attachEnv!["CLOBBER_ROLE"]).toBe("manager");
    expect(attachEnv!["CLOBBER_SESSION_ID"]).toBe(spawnBody.session_id);
    expect(typeof attachEnv!["CLOBBER_OFFICE_DIR"]).toBe("string");
    expect(attachEnv!["CLOBBER_OFFICE_DIR"]).toContain("/.clobber/offices/");
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toBeDefined();
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toContain("/.clobber/agents/");
    expect(attachEnv!["CLOBBER_DESK_DIR"]).toContain("/desk");
    expect(typeof attachEnv!["CLOBBER_SESSION_TOKEN"]).toBe("string");
    expect(attachEnv!["PATH"]!.startsWith(join(h.repoPath, ".clobber", "bin"))).toBe(true);

    expect(attachReq.appendSystemPrompt).toContain("[Previously in this office]");
    expect(attachReq.prompt).toBe("first turn");
    expect(attachReq.resume).toBeUndefined();
    expect(attachReq.providerThreadId).toBeUndefined();

    await h.records[0]!.exit(0);
    expect(h.sessions.get(spawnBody.session_id)!.ended_at).toBeUndefined();

    const resumeRes = await h.server.inject({
      method: "POST",
      url: `/sessions/${spawnBody.session_id}/prompt`,
      payload: { prompt: "second turn" },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(h.records).toHaveLength(2);

    const resumeReq = h.records[1]!.req;
    const resumeEnv = resumeReq.env;
    expect(resumeEnv).toBeDefined();
    expect(resumeEnv!["CLOBBER_API_BASE"]).toBe(attachEnv!["CLOBBER_API_BASE"]);
    expect(resumeEnv!["CLOBBER_WORKSPACE_ID"]).toBe(attachEnv!["CLOBBER_WORKSPACE_ID"]);
    expect(resumeEnv!["CLOBBER_ROLE"]).toBe(attachEnv!["CLOBBER_ROLE"]);
    expect(resumeEnv!["CLOBBER_SESSION_ID"]).toBe(spawnBody.session_id);
    expect(resumeEnv!["CLOBBER_OFFICE_DIR"]).toBe(attachEnv!["CLOBBER_OFFICE_DIR"]);
    expect(resumeEnv!["PATH"]!.startsWith(join(h.repoPath, ".clobber", "bin"))).toBe(true);

    expect(resumeEnv!["CLOBBER_DESK_DIR"]).toBeUndefined();
    expect(typeof resumeEnv!["CLOBBER_SESSION_TOKEN"]).toBe("string");
    expect(resumeEnv!["CLOBBER_SESSION_TOKEN"]).not.toBe(attachEnv!["CLOBBER_SESSION_TOKEN"]);
    expect(h.sessionTokens.lookup(resumeEnv!["CLOBBER_SESSION_TOKEN"]!)?.session_id).toBe(
      spawnBody.session_id,
    );

    expect(resumeReq.appendSystemPrompt).toContain("[Previously in this office]");
    expect(resumeReq.prompt).toBe("second turn");
    expect(resumeReq.resume).toBe(true);
    expect(resumeReq.providerThreadId).toBe(`thread-${spawnBody.session_id}`);

    await h.records[1]!.exit(0);
    await teardown(h);
  });

  it("ephemeral role: attach skips office context but still passes the shared env shape", async () => {
    const h = buildHarness(claudeRuntimeProvider);
    const ws = h.workspaces.create({ name: "ws", repo_path: h.repoPath });
    const role = h.roles.create({ name: "worker", persistent: false });
    h.workspaceRoles.setCeiling(ws.id, role.id, 1);

    const res = await h.server.inject({
      method: "POST",
      url: "/spawn",
      payload: { workspace_id: ws.id, role_id: role.id, prompt: "do work", label: "boot" },
    });
    expect(res.statusCode).toBe(200);

    expect(h.records).toHaveLength(1);
    const env = h.records[0]!.req.env;
    expect(env!["CLOBBER_OFFICE_DIR"]).toBeUndefined();
    expect(env!["CLOBBER_DESK_DIR"]).toBeDefined();
    expect(env!["CLOBBER_ROLE"]).toBe("worker");
    expect(h.records[0]!.req.prompt).toBe("do work");

    await teardown(h);
  });
});
