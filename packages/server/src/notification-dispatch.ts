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

// Re-exported so callers don't need to update their import paths. The canonical
// home is notification-rearm.ts (split for the 300-line ceiling).
export type { RearmPendingDeps } from "./notification-rearm.ts";
export { rearmPending } from "./notification-rearm.ts";
