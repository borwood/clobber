import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ClobberPromptTag, Session } from "@clobber/shared";
import { injectPrompt, type InjectPromptDeps } from "../inject-prompt.ts";
import type { AgentStore } from "../agent-store.ts";
import type { AgentStatusLogStore } from "../agent-status-log-store.ts";
import type { AgentMessageStore } from "../agent-message-store.ts";
import type { NotificationDispatcher } from "../notification-dispatch.ts";
import { withAgentAuth, type WithAgentAuthDeps } from "./_with-agent-auth.ts";

export type AgentMessagesRouteDeps = WithAgentAuthDeps &
  InjectPromptDeps & {
    readonly agents: AgentStore;
    readonly agentStatusLog: AgentStatusLogStore;
    readonly agentMessages: AgentMessageStore;
    readonly dispatcher: NotificationDispatcher;
  };

const MessageBodySchema = z.object({
  recipient_agent_id: z.string().min(1),
  body: z.string().min(1),
});

const ReplyBodySchema = z.object({
  token: z.string().min(1),
  body: z.string().min(1),
});

// The `from` label shown to the recipient: the agent's display label, falling
// back to its role name. Active sessions always carry agent_id (the FK only
// nulls it on agent delete, which kills the process first).
function senderLabel(session: Session, deps: AgentMessagesRouteDeps): string {
  const agent = session.agent_id === undefined ? null : deps.agents.get(session.agent_id);
  if (agent !== null && agent.label !== undefined) return agent.label;
  const role = deps.roles.get(session.role_id);
  if (role === null) throw new Error(`role missing for session ${session.id}`);
  return role.name;
}

function summarize(body: string): string {
  return body.length <= 80 ? body : body.slice(0, 80);
}

export function registerAgentMessagesRoutes(
  app: FastifyInstance,
  deps: AgentMessagesRouteDeps,
): void {
  // Manager → worker. Manager-only initiation is enforced by the "message"
  // capability (workers carry "reply", not "message").
  app.post(
    "/agent/messages",
    withAgentAuth("message", deps, async (request, reply, { session }) => {
      const parsed = MessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid message", issues: parsed.error.issues };
      }

      const recipientAgent = deps.agents.get(parsed.data.recipient_agent_id);
      if (recipientAgent === null || recipientAgent.workspace_id !== session.workspace_id) {
        reply.code(404);
        return { error: "recipient agent not found in this workspace" };
      }
      const recipientSession = deps.sessions.latestForAgent(recipientAgent.id);
      if (recipientSession === null) {
        reply.code(404);
        return { error: "recipient has no session" };
      }
      if (recipientSession.ended_at !== undefined) {
        reply.code(410);
        return { error: "recipient session ended" };
      }

      // Token rides inside the inbound payload, so it is minted before the
      // inject. A recipient that dies in the race surfaces as a 410 from
      // injectPrompt and the token is left dead by its recipient-lifetime rule.
      const issued = deps.agentMessages.issue({
        originator_session_id: session.id,
        recipient_session_id: recipientSession.id,
      });
      const tag: ClobberPromptTag = {
        kind: "message",
        attrs: { from: senderLabel(session, deps), token: issued.token },
      };
      // A message is a notification: a high-priority, reply-capable signal on the
      // #425 spine. The durable record is created here; the transport stays the
      // existing injectPrompt path so delivery is byte-unchanged.
      const { outcome } = await deps.dispatcher.emit(
        {
          type: "message",
          category: "durable",
          recipient: { kind: "agent", agent_id: recipientAgent.id },
          priority: "high",
          payload: { body: parsed.data.body, tag },
          provenance: {
            source_kind: "message",
            source_id: issued.message_id,
            emitter_agent_id: session.agent_id!,
          },
          metadata: {
            reply_capability: issued.token,
            recipient_session_id: recipientSession.id,
            message_id: issued.message_id,
          },
        },
        async () => {
          const result = await injectPrompt(recipientSession.id, parsed.data.body, deps, tag);
          if (result.ok) return { action: "injected", sessionId: recipientSession.id };
          return result.detail === undefined
            ? { action: "errored", error: result.error, status: result.status }
            : { action: "errored", error: result.error, status: result.status, detail: result.detail };
        },
      );
      if (outcome.action === "errored") {
        reply.code(outcome.status!);
        return outcome.detail === undefined
          ? { error: outcome.error }
          : { error: outcome.error, detail: outcome.detail };
      }

      deps.agentStatusLog.append({
        agent_id: session.agent_id!,
        session_id: session.id,
        kind: "message",
        state: "sent",
        summary: summarize(parsed.data.body),
        details: {
          recipient_session_id: recipientSession.id,
          message_id: issued.message_id,
          token: issued.token,
          body: parsed.data.body,
        },
      });
      return { message_id: issued.message_id, token: issued.token, sent_at: issued.created_at };
    }),
  );

  // Worker → originator. Single-use token; the worker opens nothing — it only
  // answers a thread the manager opened.
  app.post(
    "/agent/messages/replies",
    withAgentAuth("reply", deps, async (request, reply, { session }) => {
      const parsed = ReplyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid reply", issues: parsed.error.issues };
      }

      const tokenRow = deps.agentMessages.get(parsed.data.token);
      if (tokenRow === null) {
        reply.code(404);
        return { error: "token not found" };
      }
      if (tokenRow.recipient_session_id !== session.id) {
        reply.code(403);
        return { error: "token not addressed to this session" };
      }
      if (tokenRow.redeemed_at !== null) {
        reply.code(410);
        return { error: "token already redeemed" };
      }
      const redeemed = deps.agentMessages.redeem(parsed.data.token);
      if (!redeemed) {
        reply.code(410);
        return { error: "token already redeemed" };
      }

      const result = await injectPrompt(
        tokenRow.originator_session_id,
        parsed.data.body,
        deps,
        { kind: "message-reply", attrs: { from: senderLabel(session, deps) } },
      );
      if (!result.ok) {
        reply.code(result.status);
        return result.detail === undefined
          ? { error: result.error }
          : { error: result.error, detail: result.detail };
      }

      // Logged on the replier's (worker's) agent — its floor entry — which is
      // both the audit row and the worker-floor mirror the spec asked for (Q2).
      const row = deps.agentStatusLog.append({
        agent_id: session.agent_id!,
        session_id: session.id,
        kind: "message-reply",
        state: "replied",
        summary: summarize(parsed.data.body),
        details: {
          originator_session_id: tokenRow.originator_session_id,
          message_id: tokenRow.message_id,
          body: parsed.data.body,
        },
      });
      return { replied_at: row.created_at };
    }),
  );
}
