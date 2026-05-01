import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  HookPayloadSchema,
  PermissionModeSchema,
  CreateWorkspaceRequestSchema,
  type PermissionMode,
} from "@clobber/shared";
import type { EventStore } from "./event-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

export interface AgentSpawnRequest {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
}

export interface SpawnedAgentInfo {
  readonly sessionId: string;
  readonly pid: number;
}

export type AgentSpawner = (req: AgentSpawnRequest) => SpawnedAgentInfo;

export interface ServerOptions {
  readonly store: EventStore;
  readonly workspaces: WorkspaceStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
}

interface WorkspaceParams {
  id: string;
}

interface EventsQuery {
  session_id?: string;
}

const SpawnBodySchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
});

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, workspaces, spawner, hookUrl } = opts;

  app.post("/hook", async (request, reply) => {
    const parsed = HookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid hook payload", issues: parsed.error.issues };
    }
    store.append(parsed.data);
    return { continue: true };
  });

  app.get<{ Querystring: EventsQuery }>("/events", async (request) => {
    const { session_id } = request.query;
    return store.list(session_id ? { session_id } : undefined);
  });

  app.get("/sessions", async () => store.listSessions());

  app.post("/spawn", async (request, reply) => {
    const parsed = SpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { prompt, cwd, sessionId, permissionMode, allowedTools } = parsed.data;

    const req: AgentSpawnRequest = {
      hookUrl,
      prompt,
      cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
    };

    const result = spawner(req);
    return { sessionId: result.sessionId, pid: result.pid };
  });

  app.post("/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid workspace request", issues: parsed.error.issues };
    }
    if (workspaces.findByName(parsed.data.name) !== null) {
      reply.code(409);
      return { error: "workspace name already exists" };
    }
    const created = workspaces.create(parsed.data);
    reply.code(201);
    return created;
  });

  app.get("/workspaces", async () => workspaces.list());

  app.get<{ Params: WorkspaceParams }>("/workspaces/:id", async (request, reply) => {
    const found = workspaces.get(request.params.id);
    if (found === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    return found;
  });

  app.delete<{ Params: WorkspaceParams }>("/workspaces/:id", async (request, reply) => {
    const removed = workspaces.delete(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    reply.code(204);
    return null;
  });

  return app;
}
