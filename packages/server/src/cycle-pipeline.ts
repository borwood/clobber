import { CYCLE_ORIENTATION_LAYER } from "@clobber/shared";
import type { Agent, CycleBootFailedPayload, Role, Workspace } from "@clobber/shared";
import {
  attachSessionToAgent,
  checkCapacity,
  type SpawnPipelineDeps,
  type SpawnPipelineSuccess,
} from "./spawn-pipeline.ts";
import { resumeEndedSession } from "./resume-pipeline.ts";
import { rearmPending } from "./notification-dispatch.ts";
import { endSession } from "./session-lifecycle.ts";
import type { LayoutEventStore } from "./layout-event-store.ts";
import type { EventStore } from "./event-store.ts";
import type { Clock } from "./clock.ts";

/**
 * `clobber cycle` (#320, #510) — spawn-first re-seat that guarantees exactly
 * one live session throughout the operation.
 *
 * Kill-first (the original OQ3 design) is reversed: the fresh session boots and
 * is confirmed healthy BEFORE the old one is terminated. On boot failure the old
 * session is never touched, making an exhausted-retry cycle a harmless no-op
 * rather than permanent agent death.
 *
 * Ceiling exemption: spawn-first briefly holds two active sessions on a
 * ceiling-1 role. `checkCapacity` accepts an `excludeSessionId` so the cycle
 * replacement discounts its own kill-target from the active count, allowing the
 * transient N+1 without widening the ceiling permanently.
 *
 * Supervisor: after the kill attempt, an invariant check enforces exactly one
 * live session in both failure directions — zero (revival) and two (force-end).
 */

export interface CycleDeps extends SpawnPipelineDeps {
  readonly layoutEvents: LayoutEventStore;
  // Durable event log for cycle.boot_failed diagnostics (#510).
  readonly store: EventStore;
  // Injectable from ServerOptions; tests pass a no-op to avoid real timer delays.
  readonly sleep: (ms: number) => Promise<void>;
  // Injectable clock so cycle-reseat rearm timing is testable.
  readonly clock: Clock;
}

export interface CycleInput {
  readonly killSessionId: string;
  readonly prompt: string;
  readonly wakeProgram?: string;
}

const RESPAWN_MAX_RETRIES = 8;
const RESPAWN_BACKOFF_BASE_MS = 100;

export async function executeCycle(deps: CycleDeps, input: CycleInput): Promise<void> {
  const { killSessionId, prompt, wakeProgram = "custom" } = input;
  const old = deps.sessions.get(killSessionId);
  if (old === null) throw new Error(`cycle: session not found: ${killSessionId}`);
  const agentId = old.agent_id;
  if (agentId === undefined) throw new Error(`cycle: session has no agent: ${killSessionId}`);
  const workspace = deps.workspaces.get(old.workspace_id);
  if (workspace === null) throw new Error(`cycle: workspace not found: ${old.workspace_id}`);
  const role = deps.roles.get(old.role_id);
  if (role === null) throw new Error(`cycle: role not found: ${old.role_id}`);
  const agent = deps.agents.get(agentId);
  if (agent === null) throw new Error(`cycle: agent not found: ${agentId}`);

  // 1. Spawn fresh FIRST — the kill-target is excluded from the capacity count so
  //    the transient N+1 at ceiling-1 is allowed. On boot failure the old session
  //    is never touched, keeping the agent on the floor throughout.
  const fresh = await respawnWithRetry(deps, { workspace, role, agent, prompt, wakeProgram, killSessionId });

  // Re-arm any pending notifications for this agent that were orphaned in the
  // old session's in-memory queue (#424 cycle-orphan, #526 Phase 2).
  rearmPending(
    {
      agents: deps.agents,
      roles: deps.roles,
      workspaces: deps.workspaces,
      sessions: deps.sessions,
      registry: deps.registry,
      runtimeProvider: deps.runtimeProvider,
      attachSession: (input) => attachSessionToAgent(deps, input),
      resumeEndedSession: (input) => resumeEndedSession(deps, input),
      store: deps.notifications,
      clock: deps.clock,
    },
    agent.id,
  ).catch((err) => console.error("[clobber] rearmPending cycle error:", err));

  // 2. Kill old: deliver the signal then unconditionally clean up the DB row.
  //    Signal delivery may fail (e.g. pty already gone); endSession always runs
  //    so the DB state is consistent regardless of signal outcome.
  const live = deps.registry.get(killSessionId);
  if (live !== null) {
    try {
      live.kill("SIGTERM");
    } catch {
      // Signal failed — supervisor below enforces exactly-one via DB cleanup.
    }
    deps.registry.unregister(killSessionId);
  }
  endSession(killSessionId, deps);

  // 3. Swap the stale tab to the fresh session on the layout bus.
  deps.layoutEvents.emit(workspace.id, {
    type: "swap_session_tab",
    oldSessionId: killSessionId,
    newSessionId: fresh.session_id,
  });

  // 4. Supervisor: belt-and-suspenders invariant check. Handles edge cases where
  //    endSession was somehow skipped (DB race, unforeseen throw) or where both
  //    sessions died simultaneously.
  await superviseCycle(deps, { agentId, workspace, role, agent, killSessionId });
}

interface RespawnTarget {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
  readonly wakeProgram: string;
  // Excluded from the capacity count so the replacement is not blocked by its
  // own kill-target at ceiling-1.
  readonly killSessionId: string;
}

async function respawnWithRetry(
  deps: CycleDeps,
  target: RespawnTarget,
): Promise<SpawnPipelineSuccess> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RESPAWN_MAX_RETRIES; attempt++) {
    try {
      return await respawnOnce(deps, target);
    } catch (err) {
      lastError = err;
      recordBootFailure(deps, target, err, attempt);
      if (attempt < RESPAWN_MAX_RETRIES) {
        await deps.sleep(RESPAWN_BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function recordBootFailure(
  deps: CycleDeps,
  target: RespawnTarget,
  err: unknown,
  attempt: number,
): void {
  const error = err instanceof Error ? err.message : String(err);
  const error_stack = err instanceof Error && err.stack !== undefined ? err.stack : undefined;
  const event: CycleBootFailedPayload = {
    session_id: target.killSessionId,
    hook_event_name: "cycle.boot_failed",
    error,
    ...(error_stack !== undefined ? { error_stack } : {}),
    attempt,
    agent_id: target.agent.id,
    role_id: target.role.id,
    kill_session_id: target.killSessionId,
    ts: Date.now(),
  };
  deps.store.append(event);
}

async function respawnOnce(
  deps: CycleDeps,
  { workspace, role, agent, prompt, wakeProgram, killSessionId }: RespawnTarget,
): Promise<SpawnPipelineSuccess> {
  const capacity = checkCapacity(deps, workspace, role, killSessionId);
  if (capacity !== null) {
    throw new Error(
      `cycle respawn rejected: role at capacity (${capacity.active}/${capacity.ceiling})`,
    );
  }
  const result = await attachSessionToAgent(deps, {
    workspace,
    role,
    agent,
    prompt,
    promptTag: { kind: "wake-kick" },
    opLevelAddon: CYCLE_ORIENTATION_LAYER,
    wakeProgram,
  });
  if (!result.ok) {
    const detail = "role" in result ? ` for role '${result.role}'` : "";
    throw new Error(`cycle respawn failed${detail}: ${result.error}`);
  }
  return result;
}

interface SuperviseInput {
  readonly agentId: string;
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly killSessionId: string;
}

// Enforces exactly-one live session for the agent after a cycle operation. The
// two failure directions are handled symmetrically:
//   zero  → revive via a fresh idle session (most-recently-ended provides
//            context to the human; the fresh session wakes with no kick).
//   two+  → force-end the kill-target; the fresh session wins.
async function superviseCycle(deps: CycleDeps, input: SuperviseInput): Promise<void> {
  const { agentId, workspace, role, agent, killSessionId } = input;
  const active = deps.sessions
    .listActiveForWorkspace(workspace.id)
    .filter((s) => s.agent_id === agentId);

  if (active.length >= 2) {
    // Two sessions: kill-signal failed and endSession was skipped. Force-end
    // the old session via the DB path — leaves a potential zombie process but
    // guarantees the DB invariant that matters for clobber's floor view.
    endSession(killSessionId, deps);
    return;
  }

  if (active.length === 0) {
    // Zero sessions: both died simultaneously (race during cycle or immediate
    // crash of the fresh session). Revive by attaching a new idle session so
    // the agent reappears on the floor without requiring human intervention.
    await attachSessionToAgent(deps, {
      workspace,
      role,
      agent,
      prompt: undefined,
    });
  }
}
