import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema, type Habit, type PreToolUsePayload } from "@clobber/shared";
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
import { stubSpawnedAgent } from "./_spawner-stub.ts";

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

interface Harness {
  readonly server: ReturnType<typeof createServer>;
  readonly db: ReturnType<typeof createDatabase>;
  readonly sessionId: string;
  readonly agentId: string;
}

let repoPath: string;
// The role's grant — the gate reads this to decide which trigger paths are allowed.
let habits: readonly Habit[] = [];

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-habit-gate-"));
  // Grants the self.tool-use path. Scoped to Bash so it does not itself fire on
  // the Write PreToolUse the gate cases drive (the receiver runs on the same event).
  habits = [habit({ path: "self.tool-use", name: "seed", match: "Bash", action: { kind: "inject", hint: "h" } })];
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function buildHarness(): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    resolveSessionHabits: () => habits,
  });
  const workspace = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: `role-${randomUUID()}`, persistent: false });
  const agent = agents.create({ workspace_id: workspace.id, role_id: role.id });
  const sessionId = randomUUID();
  sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: workspace.id, role_id: role.id, pid: 9000 });
  return { server, db, sessionId, agentId: agent.id };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

function habitFilePath(agentId: string, event: string, name: string): string {
  return `.clobber/agents/${agentId}/desk/habits/self/${event}/${name}.json`;
}

function write(h: Harness, filePath: string, content: string): PreToolUsePayload {
  return {
    session_id: h.sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
    tool_use_id: `toolu_${randomUUID()}`,
  };
}

async function post(h: Harness, payload: PreToolUsePayload): Promise<Record<string, unknown>> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

const VALID = JSON.stringify(habit({ path: "self.tool-use", name: "my-habit", match: "Bash", action: { kind: "inject", hint: "x" } }));

describe("guardHabitEdit (/hook PreToolUse)", () => {
  it("allows a schema-valid edit on a granted path", async () => {
    const h = buildHarness();
    const body = await post(h, write(h, habitFilePath(h.agentId, "tool-use", "my-habit"), VALID));
    expect(body).toEqual({ continue: true });
    await teardown(h);
  });

  it("denies a schema-INVALID habit file with the permissionDecision:deny shape", async () => {
    const h = buildHarness();
    const body = await post(h, write(h, habitFilePath(h.agentId, "tool-use", "broken"), `{"path":"self.tool-use","name":"broken"}`));
    const out = body["hookSpecificOutput"] as Record<string, unknown>;
    expect(out["hookEventName"]).toBe("PreToolUse");
    expect(out["permissionDecision"]).toBe("deny");
    expect(typeof out["permissionDecisionReason"]).toBe("string");
    expect(body["decision"]).toBeUndefined(); // NOT the legacy {decision:"block"} shape
    await teardown(h);
  });

  it("denies a habit whose path is not in the role's grant", async () => {
    const h = buildHarness(); // grant = self.tool-use only
    const ungranted = JSON.stringify(habit({ path: "self.stop", name: "on-stop", action: { kind: "inject", hint: "x" } }));
    const body = await post(h, write(h, habitFilePath(h.agentId, "stop", "on-stop"), ungranted));
    expect((body["hookSpecificOutput"] as Record<string, unknown>)["permissionDecision"]).toBe("deny");
    await teardown(h);
  });

  it("ignores writes outside the desk habit tree", async () => {
    const h = buildHarness();
    const body = await post(h, write(h, "src/unrelated.ts", "const x = 1;"));
    expect(body).toEqual({ continue: true });
    await teardown(h);
  });
});

function checkoutHabitFilePath(agentId: string, event: string, name: string): string {
  return `.clobber/agents/${agentId}/desk/role-checkout/habits/self/${event}/${name}.json`;
}

// A habit with a path NOT in the editing agent's own grant (self.stop vs grant=self.tool-use).
// Written to the role-checkout tree, this is the load-bearing case for #577.
const UNGRANTED_PATH = JSON.stringify(
  habit({ path: "self.stop", name: "on-stop", action: { kind: "inject", hint: "x" } }),
);

describe("guardHabitEdit — role-checkout path exclusion (#577)", () => {
  it("AC1: allows Write into role-checkout habit tree even when path is not in agent's own grant", async () => {
    // The editing agent's grant is self.tool-use only; the habit being authored is
    // self.stop for the checked-out role. The guard must NOT apply — authority comes
    // from roles.* + role-edit-policy + commit-time re-validation, not from the
    // editing agent's own grant.
    const h = buildHarness();
    const body = await post(
      h,
      write(h, checkoutHabitFilePath(h.agentId, "stop", "on-stop"), UNGRANTED_PATH),
    );
    expect(body).toEqual({ continue: true });
    await teardown(h);
  });

  it("AC2: still denies self-authoring a habit outside the agent's own grant (gate not blinded)", async () => {
    // The same habit with path self.stop, but written directly to the agent's own
    // desk habits tree (NOT role-checkout). The role-checkout exclusion must not
    // blind the self-authoring gate.
    const h = buildHarness();
    const body = await post(h, write(h, habitFilePath(h.agentId, "stop", "on-stop"), UNGRANTED_PATH));
    expect((body["hookSpecificOutput"] as Record<string, unknown>)["permissionDecision"]).toBe("deny");
    await teardown(h);
  });
});
