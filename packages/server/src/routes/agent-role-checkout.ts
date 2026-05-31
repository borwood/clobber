import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  checkoutStatus,
  commitCheckout,
  diffCheckout,
  discardCheckout,
  openCheckout,
} from "../role-checkout.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #216 — the working-copy verb routes (checkout / status / diff / commit /
// discard). The server owns all git + DB writes; the desk holds the plain files
// the agent edits. `commit` advances the branch + pin with no new role_versions
// row — the no-demotion guarantee that closes #396. Kept separate from the
// version-store routes (agent-roles.ts) to stay under the file-size ceiling.

const CommitBodySchema = z
  .object({
    message: z.string().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export function registerAgentRoleCheckoutRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.post<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/checkout",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.checkout",
      deps,
      async (request, reply, { session }) => {
        const result = openCheckout(deps, session, request.params.idOrName);
        reply.code(result.status);
        return result.body;
      },
    ),
  );

  app.get(
    "/agent/role-checkout",
    withAgentAuth("roles.status", deps, async (_request, reply, { session }) => {
      const result = checkoutStatus(deps, session);
      reply.code(result.status);
      return result.body;
    }),
  );

  app.get(
    "/agent/role-checkout/diff",
    withAgentAuth("roles.diff", deps, async (_request, reply, { session }) => {
      const result = diffCheckout(deps, session);
      reply.code(result.status);
      return result.body;
    }),
  );

  app.post(
    "/agent/role-checkout/commit",
    withAgentAuth("roles.commit", deps, async (request, reply, { session }) => {
      const parsed = CommitBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid commit request", issues: parsed.error.issues };
      }
      const result = commitCheckout(deps, session, parsed.data);
      reply.code(result.status);
      return result.body;
    }),
  );

  app.post(
    "/agent/role-checkout/discard",
    withAgentAuth("roles.discard", deps, async (_request, reply, { session }) => {
      const result = discardCheckout(deps, session);
      reply.code(result.status);
      return result.body;
    }),
  );
}
