import type {
  FastifyReply,
  FastifyRequest,
  RouteGenericInterface,
  RouteHandlerMethod,
} from "fastify";
import type { Session } from "@clobber/shared";
import { CLI_CAPABILITY_REGISTRY, getCliCapability } from "@clobber/shared";
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

// Test-only collection: capture commandNames seen at registration time.
// No-op in production (flag stays false).
let _collecting = false;
let _collectionBuffer: string[] = [];

export function startCapabilityCollection(): void {
  _collecting = true;
  _collectionBuffer = [];
}

export function stopCapabilityCollection(): ReadonlyArray<string> {
  _collecting = false;
  const result = [..._collectionBuffer];
  _collectionBuffer = [];
  return result;
}

export function withAgentAuth<G extends RouteGenericInterface = RouteGenericInterface>(
  commandName: string,
  deps: WithAgentAuthDeps,
  handler: AuthedHandler<G>,
): RouteHandlerMethod {
  if (getCliCapability(commandName) === undefined) {
    throw new Error(
      `withAgentAuth: '${commandName}' is not in CLI_CAPABILITY_REGISTRY — ` +
        `add it to packages/shared/src/domain/cli-capabilities.ts before registering this route`,
    );
  }
  if (_collecting) {
    _collectionBuffer.push(commandName);
  }
  return async function (this: unknown, request, reply) {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const authz = authorizeCommand(auth.session, commandName, deps, auth.scope_json);
    if (!authz.ok) {
      reply.code(authz.status);
      return { error: authz.error };
    }
    return handler(request as FastifyRequest<G>, reply, { session: auth.session });
  };
}
