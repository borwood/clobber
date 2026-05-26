import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { terminateSession } from "../session-lifecycle.ts";
import { readTranscript } from "../transcript-reader.ts";
import {
  formatTranscript,
  isValidEntryId,
  parseTranscriptQuery,
  type TranscriptQuery,
} from "../transcript-formatter.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRouteDeps } from "./agent.ts";

const ResumeBodySchema = z.object({
  prompt: z.string().optional(),
});

/**
 * Routes scoped to a specific session by `:id` — the agent-facing session
 * sub-resource (transcript read + kill / resume lifecycle). Split out of
 * `agent.ts` to keep both files under the 300-line ceiling; registered as part
 * of `registerAgentRoutes`.
 */
export function registerAgentSessionRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get<{ Params: { id: string }; Querystring: TranscriptQuery }>(
    "/agent/sessions/:id/transcript",
    withAgentAuth<{ Params: { id: string }; Querystring: TranscriptQuery }>(
      "transcript",
      deps,
      async (request, reply, { session }) => {
        const target = deps.sessions.get(request.params.id);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        const parsed = parseTranscriptQuery(request.query);
        if (!parsed.ok) {
          reply.code(400);
          return { error: parsed.error };
        }
        const lines = target.transcript_path === undefined
          ? []
          : await readTranscript(target.transcript_path);
        const sel = parsed.selection;
        if (
          (sel.kind === "entry" || sel.kind === "from" || sel.kind === "to") &&
          !isValidEntryId(sel.id, lines.length)
        ) {
          reply.code(404);
          return { error: `entry id out of range: ${sel.id}` };
        }
        return formatTranscript(lines, sel, parsed.detail);
      },
    ),
  );

  app.post<{ Params: { id: string } }>(
    "/agent/sessions/:id/kill",
    withAgentAuth<{ Params: { id: string } }>(
      "kill",
      deps,
      async (request, reply, { session }) => {
        const target = deps.sessions.get(request.params.id);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        if (target.ended_at !== undefined) {
          return { ok: true };
        }
        terminateSession(target.id, deps);
        return { ok: true };
      },
    ),
  );

  app.post<{ Params: { id: string } }>(
    "/agent/sessions/:id/resume",
    withAgentAuth<{ Params: { id: string } }>(
      "resume",
      deps,
      async (request, reply, { session }) => {
        const target = deps.sessions.get(request.params.id);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        const parsed = ResumeBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid resume request", issues: parsed.error.issues };
        }
        const result = await deps.resumeEnded({
          sessionId: target.id,
          prompt: parsed.data.prompt,
        });
        if (!result.ok) {
          const { ok: _ok, status, ...rest } = result;
          reply.code(status);
          return rest;
        }
        return { session_id: result.session_id, pid: result.pid };
      },
    ),
  );
}
