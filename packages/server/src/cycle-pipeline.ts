import type { Agent, Role, Workspace } from "@clobber/shared";
import { CYCLE_WAKE_PROGRAM_NAME } from "@clobber/shared";
import {
  attachSessionToAgent,
  checkCapacity,
  type SpawnPipelineDeps,
  type SpawnPipelineSuccess,
} from "./spawn-pipeline.ts";
import { terminateSession } from "./session-lifecycle.ts";
import type { LayoutEventStore } from "./layout-event-store.ts";

/**
 * `clobber cycle` (#320) — the kill-first orchestration that re-seats an agent
 * into a fresh session: same agent identity, new session-id, clean context. It
 * composes three existing seams — `terminateSession` (kill) +
 * `attachSessionToAgent` (fresh session on the surviving agent row) + the #326
 * layout bus (tab-swap) — and is driven by the long-lived server because the
 * caller's own process is the kill target and cannot await its own replacement.
 *
 * Kill-first (OQ3) is mandatory: the role ceiling counts active sessions, so a
 * spawn-first cycle would briefly hold two on a ceiling-1 role and the respawn's
 * capacity check would 403. Killing first drops `countActive`, freeing the slot.
 * It is safe for cycle because the old context is discarded by design — the
 * durable handoff lives in office notes + the #321 token's saved prompt + the
 * surviving agent row.
 */

export interface CycleDeps extends SpawnPipelineDeps {
  readonly layoutEvents: LayoutEventStore;
}

export interface CycleInput {
  // The session to kill and re-seat. On redemption this is the token's bound
  // bearer (the caller's own session for a self-cycle, or the target that
  // redeemed for itself on a cross-agent request).
  readonly killSessionId: string;
  // The handoff brief, saved with the #321 token at mint time and replayed here
  // as the fresh session's opening kick under the reserved `cycle` program.
  readonly prompt: string;
}

// The fresh session boots immediately; a "boot failure" surfaces as a
// synchronous spawn throw. The minimal in-handler retry (the bounded form of
// the #325 spawn-health supervisor — explicitly NOT built here) recovers from a
// transient failure; the #321 token stays live across an exhausted retry as the
// durable record of intent, so the action throwing leaves it redeemable again.
const RESPAWN_MAX_RETRIES = 5;
const RESPAWN_BACKOFF_BASE_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeCycle(deps: CycleDeps, input: CycleInput): Promise<void> {
  const { killSessionId, prompt } = input;
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

  // 1. Kill the old session first → its active-session slot frees, so the
  //    respawn passes capacity even at ceiling-1. The agent row and worktree
  //    survive (endSession preserves the row, terminateSession never touches the
  //    checkout), which is what lets the fresh session re-seat in place.
  terminateSession(killSessionId, deps);

  // 2. Spawn the fresh session on the same agent under the reserved `cycle`
  //    program, retrying a transient boot failure with bounded backoff.
  const fresh = await respawnWithRetry(deps, { workspace, role, agent, prompt });

  // 3. Re-target the dead session's tab to the new session via the layout bus;
  //    clients apply it on their next poll (there is no WebSocket).
  deps.layoutEvents.emit(workspace.id, {
    type: "swap_session_tab",
    oldSessionId: killSessionId,
    newSessionId: fresh.session_id,
  });
}

interface RespawnTarget {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
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
      if (attempt < RESPAWN_MAX_RETRIES) {
        await sleep(RESPAWN_BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

async function respawnOnce(
  deps: CycleDeps,
  { workspace, role, agent, prompt }: RespawnTarget,
): Promise<SpawnPipelineSuccess> {
  const capacity = checkCapacity(deps, workspace, role);
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
    // The handoff brief is the caller's, surfaced as the cycle program's
    // caller-supplied opening turn — tagged `wake-kick` as the session's first move.
    promptTag: { kind: "wake-kick" },
    wakeProgram: CYCLE_WAKE_PROGRAM_NAME,
  });
  if (!result.ok) {
    throw new Error(`cycle respawn failed for role '${result.role}': ${result.error}`);
  }
  return result;
}
