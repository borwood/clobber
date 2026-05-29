import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { withAgentAuth, type WithAgentAuthDeps } from "./_with-agent-auth.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentStatusStore } from "../agent-status-store.ts";
import {
  runToolTokenGate,
  type ToolTokenGateDeps,
  type ToolTokenGateResult,
} from "../tool-token-gate.ts";

/**
 * The minimal internal **first consumer** of the tool-token primitive (#321) —
 * a reference for how `clobber cycle` (#320), `kill`, and other
 * high-repercussion tools wire themselves onto the shared gate. It owns only
 * its own repercussion *copy* and its `action`; all the mechanism lives in
 * `tool-token-gate.ts`.
 *
 * `POST /agent/test-tool`:
 *   - mint   (no `token`): body `{ target_session_id, effect, fail_attempts? }`
 *     → no-op + a `tool-token` interjection into the target's transcript.
 *   - redeem (`token`):     body `{ token }`
 *     → fires the action with the originally-saved args.
 */

const TOOL = "test-tool";

const TEST_TOOL_BRIEF =
  "[test-tool] This is the reference high-repercussion action. In a real tool " +
  "this paragraph would describe the irreversible consequence the bearer is " +
  "about to cause and what to wrap up first.";

const TestToolBodySchema = z.object({
  target_session_id: z.string().min(1).optional(),
  effect: z.string().min(1).optional(),
  fail_attempts: z.number().int().positive().optional(),
  token: z.string().min(1).optional(),
});

interface TestToolArgs {
  readonly effect: string;
  readonly fail_attempts?: number;
}

export interface ToolTokenTestRouteDeps extends WithAgentAuthDeps {
  readonly sessions: SessionStore;
  readonly agentStatuses: AgentStatusStore;
  readonly gate: ToolTokenGateDeps;
}

export function registerToolTokenTestRoutes(
  app: FastifyInstance,
  deps: ToolTokenTestRouteDeps,
): void {
  // Demonstrative fixture state: counts redemption attempts per token so a
  // `fail_attempts` arg can make the action fail N times before succeeding.
  // This is how the integration test exercises retry-until-success — a real
  // consumer's action fails on its own genuine error conditions.
  const attempts = new Map<string, number>();

  app.post(
    "/agent/test-tool",
    withAgentAuth(TOOL, deps, async (request, reply, { session }) => {
      const parsed = TestToolBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid test-tool request", issues: parsed.error.issues };
      }
      const body = parsed.data;

      if (body.token === undefined) {
        if (body.target_session_id === undefined || body.effect === undefined) {
          reply.code(400);
          return { error: "minting requires target_session_id and effect" };
        }
        const target = deps.sessions.get(body.target_session_id);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        if (target.ended_at !== undefined) {
          reply.code(410);
          return { error: "session ended" };
        }
        const result = await runToolTokenGate<TestToolArgs>(
          {
            tool: TOOL,
            callerSessionId: session.id,
            targetSessionId: target.id,
            args: {
              effect: body.effect,
              ...(body.fail_attempts === undefined ? {} : { fail_attempts: body.fail_attempts }),
            },
            brief: TEST_TOOL_BRIEF,
            action: noopAction,
          },
          deps.gate,
        );
        return mapResult(result, reply);
      }

      const token = body.token;
      const result = await runToolTokenGate<TestToolArgs>(
        {
          tool: TOOL,
          callerSessionId: session.id,
          token,
          brief: TEST_TOOL_BRIEF,
          action: async (args) => {
            if (args.fail_attempts !== undefined) {
              const prior = attempts.get(token) === undefined ? 0 : attempts.get(token)!;
              if (prior < args.fail_attempts) {
                attempts.set(token, prior + 1);
                throw new Error(`test-tool transient failure (attempt ${prior + 1})`);
              }
            }
            // The redeemer IS the bearer (the gate validates caller == bound
            // target), so the demonstrative effect lands on this session.
            deps.agentStatuses.upsert({
              session_id: session.id,
              state: "working",
              summary: `test-tool fired: ${args.effect}`,
            });
          },
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
  if (result.kind === "fired") return { ok: true, fired: true };
  reply.code(result.status);
  return { error: result.error };
}
