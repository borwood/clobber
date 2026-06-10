import type { RuntimeProvider } from "@clobber/runtime";
import type { CreateNotification, Notification } from "@clobber/shared";
import { writeUserTurn } from "./write-user-turn.ts";
import type { AgentStore } from "./agent-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { Clock } from "./clock.ts";
import type { AttachOutcome, AttachSessionFn } from "./trigger-attach.ts";
import type { NotificationStore } from "./notification-store.ts";
import type { ResumeEndedResult } from "./resume-pipeline.ts";

// The actions the recipient-state router can take — the existing trigger-dispatch
// outcomes, lifted verbatim so the audit row stays byte-identical.
export type DeliveryAction =
  | "spawned"
  | "resumed"
  | "injected"
  | "queued"
  | "skipped-busy"
  | "skipped-duplicate"
  | "errored";

export interface DeliveryOutcome {
  readonly action: DeliveryAction;
  readonly sessionId?: string;
  readonly error?: string;
  // Carried only by transports that answer an HTTP caller (the #93 message
  // route): the status/detail to surface when delivery fails.
  readonly status?: number;
  readonly detail?: string;
}

// What to do when the recipient is alive but busy (or its child has died but not
// yet reaped). `drop` records skipped-busy; `enqueue` hands the notification to a
// substrate that flushes it when the recipient goes idle (#171 completion wakes).
export type EnqueuePolicy =
  | { readonly kind: "drop" }
  | { readonly kind: "enqueue"; readonly enqueue: (n: Notification) => void };

export type ResumeSessionFn = (input: {
  readonly sessionId: string;
  readonly prompt: string;
}) => Promise<ResumeEndedResult>;

export interface DeliverDeps {
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly workspaces: WorkspaceStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  readonly attachSession: AttachSessionFn;
  readonly resumeEndedSession: ResumeSessionFn;
}

// The recipient-state → action router, extracted from `dispatchTrigger` and
// generalized to a `Notification` (any recipient, any source). Maps the
// recipient's lifecycle state to a delivery action and performs it.
//
// User is a first-class, presence-free recipient (Phase-2 fold-in): recorded in
// the inbox without spawn/inject; `low` → pull, `high` → priority persisted for
// Phase-3 wake-push. An absent agent recipient is a legitimate race condition
// (reaped/raced) → {action:"errored"} recorded, row stays pending. Role/workspace
// absent while the agent EXISTS is a true contract breach and still throws.
export async function deliver(
  deps: DeliverDeps,
  n: Notification,
  busyPolicy: EnqueuePolicy,
): Promise<DeliveryOutcome> {
  if (n.recipient.kind === "user") {
    // User inbox: record only. Phase-3 will build the wake-push for high-prio.
    return { action: "queued" };
  }
  // Quiet delivery: row stays pending; the hook drain producer surfaces it to the
  // agent on its next UserPromptSubmit or PostToolUse. Never wake, never inject.
  // rearmPending is safe by construction: this branch fires again → still pending.
  if (n.delivery_mode === "quiet") {
    return { action: "queued" };
  }
  const agentId = n.recipient.agent_id;
  const agent = deps.agents.get(agentId);
  if (agent === null) return { action: "errored", error: `recipient agent ${agentId} absent` };
  const role = deps.roles.get(agent.role_id);
  const workspace = deps.workspaces.get(agent.workspace_id);
  if (role === null) throw new Error(`deliver: role ${agent.role_id} not found`);
  if (workspace === null) throw new Error(`deliver: workspace ${agent.workspace_id} not found`);

  const activeForAgent = deps.sessions
    .listActiveForWorkspace(agent.workspace_id)
    .filter((s) => s.agent_id === agentId);

  if (activeForAgent.length === 0) {
    // Recipient-lifecycle gate (#605 / #424 Phase 3):
    // - non-persistent role → never auto-wake (resume-on-confirm is a later phase).
    // - low priority → enqueue; delivered at next natural wake.
    // Only high+persistent proceeds to the resume-tip-or-spawn path below.
    if (!role.persistent) return { action: "queued" };
    if (n.priority !== "high") return { action: "queued" };

    const wakeProgram = readWakeProgram(n);
    const shutdownTip = deps.sessions.latestShutdownSessionForAgentIfTip(agentId);
    if (shutdownTip !== null) {
      let resumeResult: ResumeEndedResult | undefined;
      try {
        resumeResult = await deps.resumeEndedSession({
          sessionId: shutdownTip.id,
          prompt: n.payload.body,
        });
      } catch {
        // Resume threw (e.g. transcript repair, prepareSpawnContext) — fall through
        // to fresh-spawn so the trigger lands rather than being stranded as errored.
      }
      if (resumeResult?.ok) return { action: "resumed", sessionId: resumeResult.session_id };
      // Resume returned ok:false or threw — fall through to fresh-spawn.
    }
    let spawnResult: AttachOutcome;
    try {
      spawnResult = await deps.attachSession({
        workspace,
        role,
        agent,
        prompt: n.payload.body,
        promptTag: n.payload.tag,
        ...(wakeProgram === undefined ? {} : { wakeProgram }),
      });
    } catch (err) {
      return { action: "errored", error: err instanceof Error ? err.message : String(err) };
    }
    if (spawnResult.ok) return { action: "spawned", sessionId: spawnResult.session_id };
    return { action: "errored", error: spawnResult.error };
  }

  const live = deps.registry.get(activeForAgent[0]!.id);

  // Injection-capable runtime: write-through regardless of busy. The busy gate
  // was the direct cause of worker-done stranding across cycles (#573) — a
  // persistent recipient is always busy at session start. Claude's native stdin
  // queue defers a mid-thinking write to a safe tool-result boundary on its own
  // (#367 spike — 14/14, never poisons), so the clobber-side busy gate is
  // redundant for this runtime.
  //
  // Write-through burst (#424 gap 2, bounded): N transient completions while
  // the recipient is busy produce N native-queued wakes — not 1 coalesced
  // flush-on-idle. Full flush-on-idle redesign is out-of-scope here; the
  // rearmPending path coalesces accumulated transient backlog on boot/cycle.
  // Durable (message/ask) injections must always all land, so no burst cap.
  if (live !== null && deps.runtimeProvider.capabilities.livePromptInjection) {
    writeUserTurn(live, deps.runtimeProvider, deps.registry, n.payload.body, n.payload.tag);
    return { action: "injected", sessionId: live.sessionId };
  }

  if (live === null || live.busy) {
    if (live !== null && busyPolicy.kind === "enqueue") {
      busyPolicy.enqueue(n);
      return { action: "queued", sessionId: live.sessionId };
    }
    return { action: "skipped-busy" };
  }

  return { action: "errored", error: "runtime does not support live prompt injection" };
}

// The wake-program rides on metadata (#213) so resume re-composes it for free.
// Absent → the synthesized opening kick stays the opening turn.
function readWakeProgram(n: Notification): string | undefined {
  const wp = n.metadata["wake_program"];
  if (wp === undefined) return undefined;
  if (typeof wp !== "string") {
    throw new Error(`deliver: metadata.wake_program must be a string, got ${typeof wp}`);
  }
  return wp;
}

export interface NotificationDispatcher {
  // The spine entry point: persist the durable record, then deliver it through
  // the supplied transport, advancing the record to `delivered` iff it landed.
  emit(
    req: CreateNotification,
    transport: (n: Notification) => Promise<DeliveryOutcome>,
  ): Promise<{ notification: Notification; outcome: DeliveryOutcome }>;
}

export function createNotificationDispatcher(
  store: NotificationStore,
  clock: Clock,
): NotificationDispatcher {
  return {
    async emit(req, transport) {
      const { notification, created } = store.create(req, clock.now().getTime());
      if (!created) {
        return { notification, outcome: { action: "skipped-duplicate" } };
      }
      const outcome = await transport(notification);
      if (outcome.action === "spawned" || outcome.action === "resumed" || outcome.action === "injected") {
        store.markDelivered(notification.id, clock.now().getTime());
      }
      return { notification, outcome };
    },
  };
}

export interface RearmPendingDeps extends DeliverDeps {
  readonly store: NotificationStore;
  readonly clock: Clock;
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
