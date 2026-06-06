import Fastify, { type FastifyInstance } from "fastify";
import { buildServerDeps } from "./server-deps.ts";
import { registerAllRoutes } from "./server-routes.ts";
import { rearmPending } from "./notification-dispatch.ts";
import { attachSessionToAgent } from "./spawn-pipeline.ts";
import { resumeEndedSession } from "./resume-pipeline.ts";

export type {
  AgentSpawnRequest,
  SpawnedAgentInfo,
  AgentSpawner,
  ServerOptions,
} from "./types.ts";

import type { ServerOptions } from "./types.ts";

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  // #411 — with logger:false a thrown route error left no server-side trace (a
  // checkout 500 was a black box). Log every uncaught error's stack here; the
  // default error handler still produces the response, so status semantics are
  // unchanged. Known failure modes are mapped to reasoned 4xx upstream.
  app.addHook("onError", async (_request, _reply, error) => {
    console.error("[clobber] uncaught route error:", error);
  });

  const deps = buildServerDeps(opts);
  registerAllRoutes(app, opts, deps);

  // Re-arm durable pending notifications that survived the last process boundary
  // (server restart clears the in-memory busy-queue; DB rows stay pending).
  rearmPending({
    agents: deps.spawnPipelineDeps.agents,
    roles: deps.spawnPipelineDeps.roles,
    workspaces: deps.spawnPipelineDeps.workspaces,
    sessions: deps.spawnPipelineDeps.sessions,
    registry: deps.spawnPipelineDeps.registry,
    runtimeProvider: deps.spawnPipelineDeps.runtimeProvider,
    attachSession: (input) => attachSessionToAgent(deps.spawnPipelineDeps, input),
    resumeEndedSession: (input) => resumeEndedSession(deps.spawnPipelineDeps, input),
    store: deps.notificationStore,
    clock: deps.clock,
  }).catch((err) => console.error("[clobber] rearmPending boot error:", err));

  deps.scheduler.start();
  deps.finalReportConsumer.start();
  app.addHook("onClose", async () => {
    deps.scheduler.stop();
    deps.finalReportConsumer.stop();
  });

  return app;
}
