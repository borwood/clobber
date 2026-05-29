import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRouteDeps } from "./agent.ts";
import {
  runToolTokenGate,
  type ToolTokenGateResult,
} from "../tool-token-gate.ts";
import { executeCycle } from "../cycle-pipeline.ts";

/**
 * `clobber cycle` (#320) — the first real consumer of the tool-token gate
 * (#321). An un-tokened call no-ops and injects the repercussion brief + a
 * one-time token into the TARGET's transcript (the caller's own, for a
 * self-cycle); the bearer redeems with `--token`, which fires the kill-first
 * re-seat orchestration (`executeCycle`). The saved `--prompt` travels with the
 * token and becomes the fresh session's handoff kick.
 *
 * Split out of `agent.ts` to keep both files under the 300-line ceiling;
 * registered as part of `registerAgentRoutes`.
 */

const TOOL = "cycle";

const CYCLE_BRIEF =
  "[cycle] Redeeming this token re-seats you into a BRAND-NEW session: your " +
  "current conversation and working context are discarded — a clean context " +
  "window is the whole point — your session-id changes, and your tab swaps in " +
  "place. Your agent identity, office, desk, and worktree all survive; nothing " +
  "from this conversation carries over except your office notes and the handoff " +
  "brief you saved. Make sure that brief and your office notes capture " +
  "everything your fresh self will need before you redeem.";

const CycleBodySchema = z.object({
  // The agent to cycle, defaulting to the caller (self-cycle) when omitted. The
  // CLI resolves a label/prefix to a session-id before posting.
  target_session_id: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

interface CycleArgs {
  readonly prompt: string;
}

export function registerAgentCycleRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.post(
    "/agent/cycle",
    withAgentAuth(TOOL, deps, async (request, reply, { session }) => {
      const parsed = CycleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid cycle request", issues: parsed.error.issues };
      }
      const body = parsed.data;

      if (body.token === undefined) {
        if (body.prompt === undefined) {
          reply.code(400);
          return { error: "minting a cycle requires a prompt (the handoff brief)" };
        }
        const targetSessionId = body.target_session_id ?? session.id;
        const target = deps.sessions.get(targetSessionId);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        if (target.ended_at !== undefined) {
          reply.code(410);
          return { error: "session ended" };
        }
        // v1 scope (OQ5): persistent agents only. Ephemeral/worker cycling is a
        // noted future extension; reject it here rather than half-support it.
        const role = deps.roles.get(target.role_id);
        if (role === null) {
          reply.code(500);
          return { error: "role missing for target session" };
        }
        if (!role.persistent) {
          reply.code(422);
          return { error: "cycle v1 supports persistent agents only" };
        }
        const result = await runToolTokenGate<CycleArgs>(
          {
            tool: TOOL,
            callerSessionId: session.id,
            targetSessionId: target.id,
            args: { prompt: body.prompt },
            brief: CYCLE_BRIEF,
            action: noopAction,
          },
          deps.gate,
        );
        return mapResult(result, reply);
      }

      // Redeem: the bearer (this session) presents the token; the gate validates
      // it is the bound target, then fires the kill-first cycle on itself.
      const result = await runToolTokenGate<CycleArgs>(
        {
          tool: TOOL,
          callerSessionId: session.id,
          token: body.token,
          brief: CYCLE_BRIEF,
          action: (args) =>
            executeCycle(
              { ...deps, layoutEvents: deps.layoutEvents },
              { killSessionId: session.id, prompt: args.prompt },
            ),
        },
        deps.gate,
      );
      return mapResult(result, reply);
    }),
  );
}

async function noopAction(): Promise<void> {}

function mapResult(
  result: ToolTokenGateResult,
  reply: FastifyReply,
): Record<string, unknown> {
  if (result.kind === "minted") return { ok: true, ack: result.ack };
  if (result.kind === "fired") return { ok: true, cycled: true };
  reply.code(result.status);
  return { error: result.error };
}
