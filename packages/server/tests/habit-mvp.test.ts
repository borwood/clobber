import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabitSchema, type Habit, type HookPayload } from "@clobber/shared";
import { baseRole, claudeRuntimeProvider, type RoleBundleData } from "@clobber/runtime";
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

// The MVP demonstration habit (#271 acceptance criterion): one real self.* habit
// on a dedicated fixture role. A self.tool-use `inject` that nudges the agent
// whenever it reaches for Bash.
const MVP_HABIT: Habit = HabitSchema.parse({
  path: "self.tool-use",
  phase: "pre",
  match: "Bash",
  name: "bash-quote-reminder",
  action: { kind: "inject", hint: "quote your paths before running Bash" },
});

const FIXTURE_ROLE: RoleBundleData = {
  pluginName: "habit-fixture",
  framing: "fixture",
  systemPrompt: "fixture",
  allowedTools: [],
  skills: [],
  promptModuleRefs: [],
  wakePrograms: [],
  hooksJson: baseRole.hooksJson,
  habits: [MVP_HABIT],
};

let repoPath: string;
beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-habit-mvp-"));
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

describe("#271 MVP — one self.* habit fires end-to-end without breaking baseline IPC", () => {
  it("STATIC: prepareBundle compiles the habit onto the intact 8-event baseline", () => {
    const materialized = claudeRuntimeProvider.prepareBundle({
      bundle: FIXTURE_ROLE,
      repoPath,
      hookUrl: "http://127.0.0.1:3300/hook",
      cliEntry: "/abs/cli.ts",
    });
    const parsed = JSON.parse(
      readFileSync(join(materialized.pluginDir, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, { matcher?: string }[]> };

    for (const event of [
      "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
      "PostToolUse", "Notification", "Stop", "PreCompact",
    ]) {
      expect(parsed.hooks[event]).toBeDefined(); // baseline IPC intact
    }
    expect(parsed.hooks["PreToolUse"]!.map((h) => h.matcher)).toContain("Bash");
  });

  it("DYNAMIC: the same habit fires as additionalContext on a Bash PreToolUse", async () => {
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
      apiBase: "http://test.invalid",
      cliEntry: "/dummy/cli.ts",
      dispatches: createTriggerDispatchStore(db),
      finalReportConsumerState: createFinalReportConsumerStateStore(db),
      resolveSessionHabits: () => [MVP_HABIT],
    });
    const workspace = workspaces.create({ name: "ws", repo_path: repoPath });
    const role = roles.create({ name: `role-${randomUUID()}`, persistent: false });
    const agent = agents.create({ workspace_id: workspace.id, role_id: role.id });
    const sessionId = randomUUID();
    sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: workspace.id, role_id: role.id, pid: 9000 });

    const env = { session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: repoPath, permission_mode: "bypassPermissions" as const };
    const bash: HookPayload = { ...env, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls /a b" }, tool_use_id: "t1" };
    const fired = await server.inject({ method: "POST", url: "/hook", payload: bash });
    expect(fired.json() as unknown).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "quote your paths before running Bash" },
    });

    // A non-matching tool still flows the baseline IPC contract.
    const read: HookPayload = { ...env, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" }, tool_use_id: "t2" };
    expect((await server.inject({ method: "POST", url: "/hook", payload: read })).json() as unknown).toEqual({ continue: true });

    await server.close();
    db.close();
  });
});
