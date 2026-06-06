import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { enumerateDefaultPromptModules } from "@clobber/runtime";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { createSessionTokenStore as makeTokens } from "../src/session-token-store.ts";

// #445 — prompt-module catalog CRUD routes:
//  GET  /workspaces/:id/prompt-modules           → list with source classification
//  GET  /workspaces/:id/prompt-modules/:name     → show full definition + source
//  POST /workspaces/:id/prompt-modules/:name     → create (refuse if workspace module exists)
//  PUT  /workspaces/:id/prompt-modules/:name     → edit (default-name → shadow)
//  DELETE /workspaces/:id/prompt-modules/:name   → delete (ref-safe; --force overrides)

const MODULE_DIR = ".clobber/prompt-modules";
const MODULE_FILE = "prompt-module.json";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  tokens: ReturnType<typeof makeTokens>;
  repo: RepoFixture;
  wsId: string;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(repo: RepoFixture): Harness {
  const db = createDatabase(":memory:");
  const tokens = makeTokens(db);
  let pid = 9900;
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    pid += 1;
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces: createWorkspaceStore(db),
    roles: createRoleStore(db),
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents: createAgentStore(db),
    sessions: createSessionStore(db),
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, tokens, repo, wsId: "" };
}

async function createWorkspace(h: Harness): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "test-ws", repo_path: h.repo.path },
  });
  if (res.statusCode !== 201) throw new Error(`create workspace: ${res.body}`);
  return (res.json() as { id: string }).id;
}

async function spawnToken(h: Harness, wsId: string): Promise<string> {
  const roleRow = h.db
    .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
    .get(wsId, "manager") as { id: string } | null;
  if (roleRow === null) throw new Error("manager role not seeded");
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: wsId, role_id: roleRow.id, prompt: "boot", label: "boot" },
  });
  if (res.statusCode !== 200) throw new Error(`spawn: ${res.body}`);
  return h.tokens.mint((res.json() as { session_id: string }).session_id);
}

function writeWorkspaceModule(
  repoPath: string,
  name: string,
  definition: Record<string, unknown>,
): void {
  const dir = join(repoPath, MODULE_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MODULE_FILE), JSON.stringify(definition));
}

function moduleFilePath(repoPath: string, name: string): string {
  return join(repoPath, MODULE_DIR, name, MODULE_FILE);
}

let harness: Harness;

beforeEach(async () => {
  const repo = makeRepoFixture("clobber-pm-");
  harness = buildHarness(repo);
  const wsId = await createWorkspace(harness);
  harness = { ...harness, wsId };
});

afterEach(async () => {
  await harness.server.close();
  harness.db.close();
  harness.repo.cleanup();
});

describe("GET /workspaces/:id/prompt-modules (list)", () => {
  it("lists shipped defaults with source=shipped-default", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string; kind: string; source: string }>;
    const defaults = enumerateDefaultPromptModules().map((m) => m.name);
    expect(body.length).toBeGreaterThanOrEqual(defaults.length);
    for (const name of defaults) {
      const entry = body.find((e) => e.name === name);
      expect(entry).toBeDefined();
      expect(entry!.source).toBe("shipped-default");
    }
  });

  it("lists workspace-only module with source=workspace", async () => {
    writeWorkspaceModule(harness.repo.path, "my-custom", {
      kind: "static",
      text: "custom text",
    });
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules`,
    });
    const body = res.json() as Array<{ name: string; kind: string; source: string }>;
    const entry = body.find((e) => e.name === "my-custom");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("workspace");
    expect(entry!.kind).toBe("static");
  });

  it("lists a workspace module that shadows a default with source=shadows-default", async () => {
    writeWorkspaceModule(harness.repo.path, "repo-sdlc", {
      kind: "static",
      text: "overridden repo-sdlc",
    });
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules`,
    });
    const body = res.json() as Array<{ name: string; kind: string; source: string }>;
    const entry = body.find((e) => e.name === "repo-sdlc");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("shadows-default");
  });

  it("returns 404 for unknown workspace", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: "/workspaces/no-such-ws/prompt-modules",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /workspaces/:id/prompt-modules/:name (show)", () => {
  it("returns full definition for a shipped default", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; source: string; definition: { kind: string } };
    expect(body.name).toBe("repo-sdlc");
    expect(body.source).toBe("shipped-default");
    expect(body.definition.kind).toBe("static");
  });

  it("returns full definition for a dynamic workspace module", async () => {
    writeWorkspaceModule(harness.repo.path, "my-exec", {
      kind: "dynamic",
      provider: { kind: "exec", command: "echo", args: ["hello"] },
    });
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules/my-exec`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      name: string;
      source: string;
      definition: { kind: string; provider: { kind: string } };
    };
    expect(body.name).toBe("my-exec");
    expect(body.source).toBe("workspace");
    expect(body.definition.kind).toBe("dynamic");
    expect(body.definition.provider.kind).toBe("exec");
  });

  it("returns 404 for unknown module name", async () => {
    const res = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules/no-such-module`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /workspaces/:id/prompt-modules/:name (create)", () => {
  it("creates a static workspace module on disk", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/new-guide`,
      payload: { definition: { kind: "static", text: "hello world" } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { name: string; source: string };
    expect(body.name).toBe("new-guide");
    expect(body.source).toBe("workspace");
    const filePath = moduleFilePath(harness.repo.path, "new-guide");
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf8")) as { kind: string; text: string };
    expect(written.kind).toBe("static");
    expect(written.text).toBe("hello world");
  });

  it("creates a dynamic exec module on disk", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/my-exec`,
      payload: {
        definition: {
          kind: "dynamic",
          provider: { kind: "exec", command: "echo", args: ["hi"] },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const filePath = moduleFilePath(harness.repo.path, "my-exec");
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf8")) as {
      kind: string;
      provider: { kind: string };
    };
    expect(written.kind).toBe("dynamic");
    expect(written.provider.kind).toBe("exec");
  });

  it("creates a dynamic http module on disk", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/my-http`,
      payload: {
        definition: {
          kind: "dynamic",
          provider: { kind: "http", url: "http://example.invalid/ctx" },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const filePath = moduleFilePath(harness.repo.path, "my-http");
    expect(existsSync(filePath)).toBe(true);
  });

  it("creates a shadow over a default (source=shadows-default)", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
      payload: { definition: { kind: "static", text: "my custom sdlc" } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { name: string; source: string };
    expect(body.source).toBe("shadows-default");
  });

  it("refuses with 409 if a workspace module already exists", async () => {
    writeWorkspaceModule(harness.repo.path, "existing", {
      kind: "static",
      text: "already here",
    });
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/existing`,
      payload: { definition: { kind: "static", text: "duplicate" } },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 400 for invalid definition", async () => {
    const res = await harness.server.inject({
      method: "POST",
      url: `/workspaces/${harness.wsId}/prompt-modules/bad`,
      payload: { definition: { kind: "unknown-kind" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /workspaces/:id/prompt-modules/:name (edit)", () => {
  it("replaces an existing workspace module on disk", async () => {
    writeWorkspaceModule(harness.repo.path, "existing", {
      kind: "static",
      text: "original",
    });
    const res = await harness.server.inject({
      method: "PUT",
      url: `/workspaces/${harness.wsId}/prompt-modules/existing`,
      payload: { definition: { kind: "static", text: "updated text" } },
    });
    expect(res.statusCode).toBe(200);
    const written = JSON.parse(
      readFileSync(moduleFilePath(harness.repo.path, "existing"), "utf8"),
    ) as { text: string };
    expect(written.text).toBe("updated text");
  });

  it("forks a workspace shadow when editing a shipped default (source=shadows-default)", async () => {
    const res = await harness.server.inject({
      method: "PUT",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
      payload: { definition: { kind: "static", text: "overridden" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; source: string; shadowed_default: boolean };
    expect(body.source).toBe("shadows-default");
    expect(body.shadowed_default).toBe(true);
    expect(existsSync(moduleFilePath(harness.repo.path, "repo-sdlc"))).toBe(true);
  });

  it("returns 404 when editing a name not in defaults or workspace", async () => {
    const res = await harness.server.inject({
      method: "PUT",
      url: `/workspaces/${harness.wsId}/prompt-modules/totally-unknown`,
      payload: { definition: { kind: "static", text: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("replaces a dynamic module with a static one", async () => {
    writeWorkspaceModule(harness.repo.path, "was-dynamic", {
      kind: "dynamic",
      provider: { kind: "exec", command: "echo" },
    });
    const res = await harness.server.inject({
      method: "PUT",
      url: `/workspaces/${harness.wsId}/prompt-modules/was-dynamic`,
      payload: { definition: { kind: "static", text: "now static" } },
    });
    expect(res.statusCode).toBe(200);
    const written = JSON.parse(
      readFileSync(moduleFilePath(harness.repo.path, "was-dynamic"), "utf8"),
    ) as { kind: string };
    expect(written.kind).toBe("static");
  });
});

describe("DELETE /workspaces/:id/prompt-modules/:name (delete)", () => {
  it("deletes a workspace module from disk", async () => {
    writeWorkspaceModule(harness.repo.path, "deletable", { kind: "static", text: "bye" });
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/deletable`,
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(moduleFilePath(harness.repo.path, "deletable"))).toBe(false);
  });

  it("refuses to delete a pure shipped default (no workspace file)", async () => {
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/shipped default/i);
  });

  it("refuses with 422 even when force=true for a pure default", async () => {
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc?force=true`,
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses with 409 when a row-backed role still refs the module", async () => {
    writeWorkspaceModule(harness.repo.path, "referenced", { kind: "static", text: "x" });
    // Inject a seed_ref into the manager's latest role_version row
    const roleRow = harness.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
      .get(harness.wsId, "manager") as { id: string } | null;
    const latestVersion = roleRow === null ? null : (harness.db
      .prepare("SELECT id, seed_refs_json FROM role_versions WHERE role_id = ? ORDER BY version DESC LIMIT 1")
      .get(roleRow.id) as { id: string; seed_refs_json: string } | null);
    if (latestVersion !== null) {
      const refs = JSON.parse(latestVersion.seed_refs_json) as Array<{ name: string; enabled: boolean }>;
      refs.push({ name: "referenced", enabled: true });
      harness.db
        .prepare("UPDATE role_versions SET seed_refs_json = ? WHERE id = ?")
        .run(JSON.stringify(refs), latestVersion.id);
    }
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/referenced`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; blocking_roles: Array<{ name: string }> };
    expect(body.error).toMatch(/ref/i);
    expect(body.blocking_roles.length).toBeGreaterThan(0);
  });

  it("deletes when force=true even if a role refs it", async () => {
    writeWorkspaceModule(harness.repo.path, "force-deletable", { kind: "static", text: "x" });
    const roleRow = harness.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
      .get(harness.wsId, "manager") as { id: string } | null;
    const latestVersion = roleRow === null ? null : (harness.db
      .prepare("SELECT id, seed_refs_json FROM role_versions WHERE role_id = ? ORDER BY version DESC LIMIT 1")
      .get(roleRow.id) as { id: string; seed_refs_json: string } | null);
    if (latestVersion !== null) {
      const refs = JSON.parse(latestVersion.seed_refs_json) as Array<{ name: string; enabled: boolean }>;
      refs.push({ name: "force-deletable", enabled: true });
      harness.db
        .prepare("UPDATE role_versions SET seed_refs_json = ? WHERE id = ?")
        .run(JSON.stringify(refs), latestVersion.id);
    }
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/force-deletable?force=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(moduleFilePath(harness.repo.path, "force-deletable"))).toBe(false);
  });

  it("allows deleting a workspace shadow of a default", async () => {
    // Shadow exists in workspace FS → delete the workspace file
    writeWorkspaceModule(harness.repo.path, "repo-sdlc", {
      kind: "static",
      text: "shadow",
    });
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect(res.statusCode).toBe(200);
    // The file is gone, the shipped default is still there (via enumerateDefaultPromptModules)
    expect(existsSync(moduleFilePath(harness.repo.path, "repo-sdlc"))).toBe(false);
  });

  it("refuses with 409 when a commit-pinned role refs the module; succeeds with --force", async () => {
    // Exercises the commitPinned branch in rolesReferencingModule:
    // current_version_id IS NULL, current_commit_sha set, materialized_role_cache row present.
    writeWorkspaceModule(harness.repo.path, "cp-ref-test", { kind: "static", text: "x" });

    const workerRow = harness.db
      .prepare("SELECT id FROM roles WHERE workspace_id = ? AND name = ?")
      .get(harness.wsId, "worker") as { id: string };
    const testSha = "deadbeef000000000000000000000001";
    harness.db
      .prepare("UPDATE roles SET current_commit_sha = ? WHERE id = ?")
      .run(testSha, workerRow.id);
    harness.db
      .prepare(
        "INSERT INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        testSha,
        JSON.stringify({ seedRefs: [{ name: "cp-ref-test", enabled: true }] }),
        1,
        Date.now(),
      );

    // Without --force → 409 and the worker appears in blocking_roles
    const blocked = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/cp-ref-test`,
    });
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as { blocking_roles: Array<{ name: string }> };
    expect(body.blocking_roles.some((r) => r.name === "worker")).toBe(true);
    expect(existsSync(moduleFilePath(harness.repo.path, "cp-ref-test"))).toBe(true);

    // With --force → 200, workspace file removed
    const forced = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/cp-ref-test?force=true`,
    });
    expect(forced.statusCode).toBe(200);
    expect(existsSync(moduleFilePath(harness.repo.path, "cp-ref-test"))).toBe(false);
  });

  it("catalog still resolves a name via shipped default after its workspace shadow is deleted", async () => {
    // A role refs repo-sdlc (seeded manager already does). Deleting the workspace
    // shadow removes the override but the shipped default remains — the ref is
    // still satisfied, the catalog still returns the name, and the source flips
    // back to shipped-default.
    writeWorkspaceModule(harness.repo.path, "repo-sdlc", { kind: "static", text: "shadow" });

    const before = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect((before.json() as { source: string }).source).toBe("shadows-default");

    const del = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect(del.statusCode).toBe(200);

    // The catalog still resolves repo-sdlc — the role's ref remains satisfied.
    const after = await harness.server.inject({
      method: "GET",
      url: `/workspaces/${harness.wsId}/prompt-modules/repo-sdlc`,
    });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { name: string; source: string };
    expect(afterBody.name).toBe("repo-sdlc");
    expect(afterBody.source).toBe("shipped-default");
  });

  it("returns 404 for an unknown module (not in defaults or workspace)", async () => {
    const res = await harness.server.inject({
      method: "DELETE",
      url: `/workspaces/${harness.wsId}/prompt-modules/no-such`,
    });
    expect(res.statusCode).toBe(404);
  });
});
