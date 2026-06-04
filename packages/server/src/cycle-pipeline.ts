import type { Agent, Role, Workspace } from "@clobber/shared";
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

// The orientation text is the op-level system layer for a cycled session (#502).
// It is structural only — no behavioral directives, no prescription — so it is
// safe to stamp on every cycle regardless of the chosen wake-program. Verbatim
// per the spec; do not alter without confirming with the workspace owner.
const CYCLE_ORIENTATION_LAYER = [
  "You are a freshly-cycled embodiment of this agent. You have NO prior",
  "conversation — your predecessor shed its working context deliberately so",
  "that you start clean. Your continuity does not live in this session's",
  "history; it lives in your office notes and in the handoff brief that",
  "follows as your opening turn. Read your office notes first, then act on the",
  "handoff.",
].join("\n");

export interface CycleInput {
  // The session to kill and re-seat. On redemption this is the token's bound
  // bearer (the caller's own session for a self-cycle, or the target that
  // redeemed for itself on a cross-agent request).
  readonly killSessionId: string;
  // The handoff brief replayed as the fresh session's opening kick.
  readonly prompt: string;
  // The wake-program for the fresh session. Defaults to "custom" so that a
  // plain `cycle --prompt X` preserves today's X-as-kick behavior unchanged.
  readonly wakeProgram?: string;
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

  // 1. Kill the old session first → its active-session slot frees, so the
  //    respawn passes capacity even at ceiling-1. The agent row and worktree
  //    survive (endSession preserves the row, terminateSession never touches the
  //    checkout), which is what lets the fresh session re-seat in place.
  terminateSession(killSessionId, deps);

  // 2. Spawn the fresh session on the same agent with the op-level orientation
  //    layer and the caller's chosen wake-program, retrying on transient boot
  //    failure with bounded backoff.
  const fresh = await respawnWithRetry(deps, { workspace, role, agent, prompt, wakeProgram });

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
  readonly wakeProgram: string;
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
  { workspace, role, agent, prompt, wakeProgram }: RespawnTarget,
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
    // The handoff brief is the caller's opening kick — tagged `wake-kick`.
    promptTag: { kind: "wake-kick" },
    // The cycle operation always injects the orientation as the op-level layer,
    // independently of the chosen wake-program.
    opLevelAddon: CYCLE_ORIENTATION_LAYER,
    wakeProgram,
  });
  if (!result.ok) {
    throw new Error(`cycle respawn failed for role '${result.role}': ${result.error}`);
  }
  return result;
}
