import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { CLI_CAPABILITY_REGISTRY } from "@clobber/shared";
import {
  withAgentAuth,
  startCapabilityCollection,
  stopCapabilityCollection,
  type WithAgentAuthDeps,
} from "@clobber/server/routes/_with-agent-auth.ts";
import { createServer } from "@clobber/server/server.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { createEventStore } from "@clobber/server/event-store.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { createRoleVersionStore } from "@clobber/server/role-version-store.ts";
import { createWorkspaceRoleStore } from "@clobber/server/workspace-role-store.ts";
import { createAgentStore } from "@clobber/server/agent-store.ts";
import { createSessionStore } from "@clobber/server/session-store.ts";
import { createWorkspaceSessionSummaries } from "@clobber/server/workspace-session-summaries.ts";
import { createSessionTokenStore } from "@clobber/server/session-token-store.ts";
import { createAgentStatusStore } from "@clobber/server/agent-status-store.ts";
import { createAgentStatusLogStore } from "@clobber/server/agent-status-log-store.ts";
import { createAgentQuestionStore } from "@clobber/server/agent-question-store.ts";
import { createAgentQuestionWaiter } from "@clobber/server/agent-question-waiter.ts";
import type { SpawnedAgentInfo } from "@clobber/server/types.ts";
import { createTriggerDispatchStore } from "@clobber/server/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "@clobber/server/final-report-consumer.ts";
import { DRIFT_STUB_API_BASE } from "@clobber/server/_drift-stub.ts";
import { buildCommandRegistry } from "../src/main.ts";

// #554 — convergence tests that lock the capability registry against drift:
//   1. Boot-collection: spin up a real server; assert withAgentAuth's collected
//      names match registry exactly (missing route → throws at boot; orphan
//      entry → set diff fails).
//   2. Guard fires: proves the registration assertion is not inert.
//   3. CLI subcommand refs: every non-local CLI subcommand capability resolves.

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

describe("CLI capability registry convergence", () => {
  let app: ReturnType<typeof createServer>;
  let db: ReturnType<typeof createDatabase>;
  let collectedNames: Set<string>;

  beforeAll(async () => {
    db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const roleVersions = createRoleVersionStore(db);
    const workspaceRoles = createWorkspaceRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const tokens = createSessionTokenStore(db);

    const stub: SpawnedAgentInfo = {
      sessionId: "stub",
      pid: 9000,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };

    startCapabilityCollection();
    app = createServer({
      db,
      store: createEventStore(db),
      workspaces,
      roles,
      roleVersions,
      workspaceRoles,
      agents,
      sessions,
      sessionSummaries: createWorkspaceSessionSummaries(db),
      sessionTokens: tokens,
      agentStatuses: createAgentStatusStore(db),
      agentStatusLog: createAgentStatusLogStore(db),
      agentQuestions: createAgentQuestionStore(db),
      agentQuestionWaiter: createAgentQuestionWaiter(),
      spawner: () => ({ ...stub, sessionId: randomUUID() }),
      hookUrl: "http://test.invalid/hook",
      apiBase: DRIFT_STUB_API_BASE,
      cliEntry: "/dummy/cli.ts",
      dispatches: createTriggerDispatchStore(db),
      finalReportConsumerState: createFinalReportConsumerStateStore(db),
    });
    // registerAllRoutes runs synchronously inside createServer, so all
    // withAgentAuth calls have already fired by this point.
    collectedNames = new Set(stopCapabilityCollection());
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it("boot-collected names match registry exactly — no missing routes, no orphan entries", () => {
    const registryNames = [...Object.keys(CLI_CAPABILITY_REGISTRY)].sort();
    const collected = [...collectedNames].sort();
    expect(collected).toEqual(registryNames);
  });

  it("withAgentAuth throws at registration for an unregistered commandName", () => {
    expect(() =>
      withAgentAuth("_test_guard_fires_xyz_", {} as WithAgentAuthDeps, async () => 0),
    ).toThrow("_test_guard_fires_xyz_");
  });

  it("every non-local CLI subcommand capability ref resolves in the registry", () => {
    const registryNames = new Set(Object.keys(CLI_CAPABILITY_REGISTRY));
    const registry = buildCommandRegistry();
    const dangling: string[] = [];
    for (const cmd of registry.list()) {
      if (cmd.local === true) continue;
      for (const sub of cmd.subcommands ?? []) {
        if (sub.capability === undefined) continue;
        if (!registryNames.has(sub.capability)) {
          dangling.push(`${cmd.name} ${sub.name} → "${sub.capability}"`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});
