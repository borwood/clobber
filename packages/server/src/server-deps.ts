import { claudeRuntimeProvider } from "@clobber/runtime";
import { createAgentMessageStore } from "./agent-message-store.ts";
import { createNotificationStore } from "./notification-store.ts";
import { createNotificationDispatcher } from "./notification-dispatch.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { createToolTokenStore } from "./tool-token-store.ts";
import type { ToolTokenGateDeps } from "./tool-token-gate.ts";
import { injectPrompt } from "./inject-prompt.ts";
import { createLayoutEventStore } from "./layout-event-store.ts";
import { createTriggerScheduler } from "./trigger-scheduler.ts";
import { createFinalReportConsumer } from "./final-report-consumer.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "./spawn-pipeline.ts";
import { resumeSessionTurn, resumeEndedSession } from "./resume-pipeline.ts";
import type { RearmPendingDeps } from "./notification-rearm.ts";
import { bootServerRoles } from "./boot-server-roles.ts";
import { createSystemClock } from "./clock.ts";
import { createSessionHabitsResolver, runHabitBash } from "./resolve-session-habits.ts";
import { tailReadTranscript } from "./transcript-reader.ts";
import type { ServerOptions } from "./types.ts";

export function buildServerDeps(opts: ServerOptions) {
  const registry = createAgentRegistry();
  const toolTokens = createToolTokenStore(opts.db);
  const layoutEvents =
    opts.layoutEvents === undefined ? createLayoutEventStore() : opts.layoutEvents;
  const clock = opts.clock === undefined ? createSystemClock() : opts.clock;
  // The notification spine (#425): one dispatcher shared by the trigger emitter
  // and the #93 message route so every cross-agent signal lands on one record.
  const notificationStore = createNotificationStore(opts.db);
  const notificationDispatcher = createNotificationDispatcher(notificationStore, clock);
  const runtimeProvider =
    opts.runtimeProvider === undefined ? claudeRuntimeProvider : opts.runtimeProvider;

  // Boot-time role wiring (before routes): #349 git-as-truth.
  // When a roleContentCache override is injected, skip git materialization so
  // tests can pre-seed the cache without a real role repo.
  const roleEmbodiment = {
    ...bootServerRoles({
      db: opts.db,
      roleRepoDir: opts.roleContentCache !== undefined ? undefined : opts.roleRepoDir,
    }),
    ...(opts.roleContentCache !== undefined
      ? { roleContentCache: opts.roleContentCache, roleRepoDir: opts.roleRepoDir }
      : {}),
  };

  // Declared before construction so onSessionEnded can reference it without a
  // circular dependency — the scheduler closes over spawnPipelineDeps in turn.
  let scheduler: ReturnType<typeof createTriggerScheduler>;
  const onSessionEnded = (workspaceId: string, finishedSessionId: string): void => {
    void scheduler.fireSessionEnded(workspaceId, finishedSessionId);
  };
  const onWorkerDone = (workspaceId: string, finishedSessionId: string): void => {
    void scheduler.fireWorkerDone(workspaceId, finishedSessionId);
  };

  const spawnPipelineDeps: SpawnPipelineDeps = {
    workspaces: opts.workspaces,
    workspaceRoles: opts.workspaceRoles,
    agents: opts.agents,
    sessions: opts.sessions,
    sessionTokens: opts.sessionTokens,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    registry,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    ...roleEmbodiment,
    runtimeProvider,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    onSessionEnded,
    notifications: notificationStore,
  };

  scheduler = createTriggerScheduler({
    db: opts.db,
    clock,
    workspaces: opts.workspaces,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agents: opts.agents,
    sessions: opts.sessions,
    registry,
    runtimeProvider,
    dispatches: opts.dispatches,
    agentStatusLog: opts.agentStatusLog,
    dispatcher: notificationDispatcher,
    attachSession: (input) => attachSessionToAgent(spawnPipelineDeps, input),
    resumeEndedSession: (input) => resumeEndedSession(spawnPipelineDeps, input),
    // #385 — the manager's wake path resolves triggers through the commit-pin
    // view, so a git-backed (commit-pinned) manager still registers and wakes.
    ...roleEmbodiment,
  });

  // The tool-token primitive's first consumer (#321). The gate injects the
  // repercussion brief into the bearer's transcript via the same `injectPrompt`
  // path the session routes use; saved args replay on redemption.
  const injectDeps = {
    ...spawnPipelineDeps,
    resumeTurn: (input: { sessionId: string; prompt: string }) =>
      resumeSessionTurn(spawnPipelineDeps, input),
  };
  const toolTokenGate: ToolTokenGateDeps = {
    tokens: toolTokens,
    inject: (sessionId, content, tag) => injectPrompt(sessionId, content, injectDeps, tag),
  };

  const agentMessages = createAgentMessageStore(opts.db);
  const resolveSessionHabits =
    opts.resolveSessionHabits === undefined
      ? createSessionHabitsResolver({
          roles: opts.roles,
          roleVersions: opts.roleVersions,
          ...roleEmbodiment,
        })
      : opts.resolveSessionHabits;
  const random = opts.habitRandom === undefined ? Math.random : opts.habitRandom;
  const runBash = opts.habitRunBash === undefined ? runHabitBash : opts.habitRunBash;
  const readTranscriptTail =
    opts.habitReadTranscriptTail === undefined ? tailReadTranscript : opts.habitReadTranscriptTail;
  const resumeTurn = (input: { sessionId: string; prompt: string }) =>
    resumeSessionTurn(spawnPipelineDeps, input);
  const resumeEnded = (input: { sessionId: string; prompt: string | undefined }) =>
    resumeEndedSession(spawnPipelineDeps, input);

  const finalReportConsumer = createFinalReportConsumer({
    db: opts.db,
    workspaces: opts.workspaces,
    agentStatusLog: opts.agentStatusLog,
    stateStore: opts.finalReportConsumerState,
    clock,
  });

  const rearmDeps: RearmPendingDeps = {
    agents: opts.agents,
    roles: opts.roles,
    workspaces: opts.workspaces,
    sessions: opts.sessions,
    registry,
    runtimeProvider,
    attachSession: (input) => attachSessionToAgent(spawnPipelineDeps, input),
    resumeEndedSession: (input) => resumeEndedSession(spawnPipelineDeps, input),
    store: notificationStore,
    clock,
    resolveOwner: (agentId) => opts.agents.get(agentId)?.spawner_agent_id ?? null,
    agentMessages,
  };

  return {
    registry,
    toolTokens,
    layoutEvents,
    clock,
    notificationStore,
    notificationDispatcher,
    runtimeProvider,
    roleEmbodiment,
    scheduler,
    spawnPipelineDeps,
    injectDeps,
    toolTokenGate,
    agentMessages,
    resolveSessionHabits,
    random,
    runBash,
    readTranscriptTail,
    resumeTurn,
    resumeEnded,
    rearmDeps,
    finalReportConsumer,
    onSessionEnded,
    onWorkerDone,
  };
}

export type ServerDeps = ReturnType<typeof buildServerDeps>;
