import type { CreateNotification, Notification } from "@clobber/shared";
import { deliver, type DeliverDeps, type DeliveryOutcome } from "./notification-dispatch.ts";
import type { NotificationStore } from "./notification-store.ts";
import type { Clock } from "./clock.ts";
import type { AgentMessageStore } from "./agent-message-store.ts";

export interface RearmPendingDeps extends DeliverDeps {
  readonly store: NotificationStore;
  readonly clock: Clock;
  // Returns the owner (capability-holder) agent ID for a given agent, or null
  // if the agent has no owner. Used to route confirm-resume prompts (#621).
  // Default production wiring: read spawner_agent_id from the agents table.
  // The seam lets future roles override escalation logic without engine changes.
  readonly resolveOwner: (agentId: string) => string | null;
  // Used to mint a single-use authorization token embedded in the confirm-resume
  // tag. The endpoint requires+consumes it so only the notified owner can resume.
  readonly agentMessages: AgentMessageStore;
}

// Re-arm pending rows through the existing deliver() core. Called on server
// boot and cycle-reseat boot so notifications survive process boundaries.
// The in-memory busy queue evaporates on restart; the DB row stays pending and
// is picked up here. Optional `agentId` scopes re-arm to a single recipient
// (cycle-reseat: only that agent's orphaned rows need re-queueing).
//
// Category-aware coalescing (#616):
// - transient (trigger/wake): per-recipient latest-only. Stale rows are
//   cancelled (never trickle-deliver). listPending() is ASC so the last entry
//   per recipient is the newest.
// - durable (message/ask): per-recipient deliver-all. Distinct messages must
//   not be starved by a latest-only filter.
// - quiet rows: excluded — drainQuietForAgent owns them.
//
// Ephemeral confirm-resume (#621): after the deliver pass, any non-persistent
// recipient with queued rows and no active session emits exactly one
// confirm-resume notification to its owner (logical_key dedup = no nagware).
export async function rearmPending(deps: RearmPendingDeps, agentId?: string): Promise<void> {
  const pending = deps.store.listPending();
  const targets =
    agentId === undefined
      ? pending
      : pending.filter(
          (n) => n.recipient.kind === "agent" && n.recipient.agent_id === agentId,
        );

  // Bucket per recipient×category, skipping quiet rows.
  const transientByRecipient = new Map<string, Notification[]>();
  const durableByRecipient = new Map<string, Notification[]>();

  for (const n of targets) {
    if (n.delivery_mode === "quiet") continue;
    const key = n.recipient.kind === "user" ? "\0user" : n.recipient.agent_id;
    if (n.category === "transient") {
      const bucket = transientByRecipient.get(key) ?? [];
      bucket.push(n);
      transientByRecipient.set(key, bucket);
    } else {
      const bucket = durableByRecipient.get(key) ?? [];
      bucket.push(n);
      durableByRecipient.set(key, bucket);
    }
  }

  // Cancel stale transient rows before delivering the latest, so they can
  // never trickle-deliver on a future rearm.
  //
  // Applies to ALL recipients (persistent AND non-persistent): stale wakes for
  // a dead ephemeral agent serve no purpose — the agent will never auto-wake and
  // deliver() would return queued anyway. Cancelling cleans up indefinitely
  // accumulating rows for ended ephemeral recipients.
  //
  // Crash-recovery: cancels commit before deliverAndMark, so if the process
  // dies between the two calls the stale rows stay cancelled and the latest
  // row remains pending — it will be retried on the next rearm. No row is
  // lost; at worst the latest is delivered twice (idempotent at the recipient).
  for (const bucket of transientByRecipient.values()) {
    const staleIds = bucket.slice(0, -1).map((n) => n.id);
    if (staleIds.length > 0) deps.store.cancelBulk(staleIds);
  }

  // Deliver the latest transient row per recipient.
  for (const bucket of transientByRecipient.values()) {
    const latest = bucket[bucket.length - 1]!;
    await deliverAndMark(deps, latest);
  }

  // Deliver all durable rows. Order within a recipient's bucket is oldest-first
  // (listPending ASC). Cross-recipient delivery order is unguaranteed — durable
  // rows for different recipients may interleave depending on bucket iteration.
  for (const bucket of durableByRecipient.values()) {
    for (const n of bucket) {
      await deliverAndMark(deps, n);
    }
  }

  // Ephemeral confirm-resume (#621): for each agent-recipient that had queued
  // rows, check if it is a dead non-persistent agent with an owner. If so, emit
  // exactly one confirm-resume notification to the owner (logical_key dedup).
  const agentKeys = new Set<string>();
  for (const key of transientByRecipient.keys()) {
    if (key !== "\0user") agentKeys.add(key);
  }
  for (const key of durableByRecipient.keys()) {
    if (key !== "\0user") agentKeys.add(key);
  }
  for (const recipientAgentId of agentKeys) {
    await maybeEmitConfirmToOwner(deps, recipientAgentId);
  }
}

async function deliverAndMark(deps: RearmPendingDeps, n: Notification): Promise<void> {
  let outcome: DeliveryOutcome;
  try {
    outcome = await deliver(deps, n, { kind: "drop" });
  } catch {
    // One poison row must not abort re-arm of the remaining rows — batch
    // isolation mirrors the drift-sweep route's per-role try/clean-report.
    return;
  }
  if (outcome.action === "spawned" || outcome.action === "resumed" || outcome.action === "injected") {
    deps.store.markDelivered(n.id, deps.clock.now().getTime());
  }
}

// Emits a confirm-resume notification to the owner of a dead ephemeral agent
// when that agent has queued rows. Skips persistent agents (they auto-wake) and
// agents without an owner. The logical_key derived from source_kind + source_id
// + recipient guarantees exactly one prompt regardless of how many times
// rearmPending fires — no nagware.
async function maybeEmitConfirmToOwner(deps: RearmPendingDeps, recipientAgentId: string): Promise<void> {
  const agent = deps.agents.get(recipientAgentId);
  if (agent === null) return;

  const role = deps.roles.get(agent.role_id);
  if (role === null) return;
  if (role.persistent) return;

  // Only emit when the agent has no active session.
  const active = deps.sessions
    .listActiveForWorkspace(agent.workspace_id)
    .filter((s) => s.agent_id === recipientAgentId);
  if (active.length > 0) return;

  const ownerAgentId = deps.resolveOwner(recipientAgentId);
  if (ownerAgentId === null) return;

  // No ended session → nothing to resume; skip confirm emission.
  const lastEnded = deps.sessions.latestEndedForAgent(recipientAgentId);
  if (lastEnded === null) return;
  const deadSessionId = lastEnded.id;

  // Mint a single-use token bound to the dead session. The endpoint validates
  // this token before resuming so only the notified owner can trigger a resume.
  // If the logical_key dedup fires below (notification already exists), the
  // token becomes an orphan — harmless, since it will never be redeemed.
  const issued = deps.agentMessages.issue({
    originator_session_id: deadSessionId,
    recipient_session_id: deadSessionId,
  });

  const req: CreateNotification = {
    type: "confirm-resume",
    category: "durable",
    recipient: { kind: "agent", agent_id: ownerAgentId },
    priority: "high",
    payload: {
      body: `Agent ${recipientAgentId} has queued notifications but its session has ended. Confirm to resume or decline to leave rows queued.`,
      tag: { kind: "confirm-resume", attrs: { dead_agent_id: recipientAgentId, dead_session_id: deadSessionId, token: issued.token } },
    },
    provenance: {
      source_kind: "confirm-resume",
      // source_id drives the logical_key: confirm-resume:<agentId>:<sessionId>:<ownerAgentId>
      source_id: `${recipientAgentId}:${deadSessionId}`,
    },
    metadata: {
      dead_agent_id: recipientAgentId,
      dead_session_id: deadSessionId,
    },
  };

  deps.store.create(req, deps.clock.now().getTime());
}
