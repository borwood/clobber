import type {
  FastifyReply,
  FastifyRequest,
  RouteGenericInterface,
  RouteHandlerMethod,
} from "fastify";
import type { Session } from "@clobber/shared";
import {
  authorizeCommand,
  resolveCallerSession,
  type AgentAuthDeps,
  type CommandAuthzDeps,
} from "./_agent-auth.ts";

export type WithAgentAuthDeps = AgentAuthDeps & CommandAuthzDeps;

export interface AgentAuthContext {
  readonly session: Session;
}

export type AuthedHandler<G extends RouteGenericInterface = RouteGenericInterface> = (
  req: FastifyRequest<G>,
  reply: FastifyReply,
  ctx: AgentAuthContext,
) => unknown | Promise<unknown>;

export function withAgentAuth<G extends RouteGenericInterface = RouteGenericInterface>(
  commandName: string,
  deps: WithAgentAuthDeps,
  handler: AuthedHandler<G>,
): RouteHandlerMethod {
  return async function (this: unknown, request, reply) {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const authz = authorizeCommand(auth.session, commandName, deps);
    if (!authz.ok) {
      reply.code(authz.status);
      return { error: authz.error };
    }
    return handler(request as FastifyRequest<G>, reply, { session: auth.session });
  };
}
