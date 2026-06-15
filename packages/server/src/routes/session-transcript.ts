import type { FastifyInstance } from "fastify";
import type { TranscriptFetchResponse } from "@clobber/shared";
import type { SessionStore } from "../session-store.ts";
import { readTranscript } from "../transcript-reader.ts";

interface IdParam {
  id: string;
}

interface TranscriptQuery {
  since?: string;
}

/**
 * GET /sessions/:id/transcript
 *
 * Cold fetch (no ?since): returns the system-prompt prefix + all JSONL lines.
 * Cursor is the JSONL line count (prefix excluded from cursor arithmetic).
 *
 * Incremental fetch (?since=N): returns only lines with offset > N, no prefix.
 * Cursor = total JSONL line count after the read.
 *
 * Line offset is the natural cursor for an append-only JSONL file (#671).
 */
export function registerSessionTranscriptRoute(
  app: FastifyInstance,
  deps: { sessions: SessionStore },
): void {
  app.get<{ Params: IdParam; Querystring: TranscriptQuery }>(
    "/sessions/:id/transcript",
    async (request, reply): Promise<TranscriptFetchResponse> => {
      const session = deps.sessions.get(request.params.id);
      if (session === null) {
        reply.code(404);
        return reply.send({ error: "session not found" });
      }

      const jsonlLines =
        session.transcript_path === undefined
          ? []
          : await readTranscript(session.transcript_path);

      const sinceStr = request.query.since;

      if (sinceStr !== undefined) {
        // Incremental fetch: no prefix, only lines after the cursor offset.
        const since = Number(sinceStr);
        return { lines: jsonlLines.slice(since), cursor: jsonlLines.length };
      }

      // Cold fetch: prepend the system-prompt pseudo-line when present (#253).
      // Cursor counts only JSONL lines so incremental polls stay consistent.
      const prefix =
        session.composed_system_prompt === undefined
          ? []
          : [{ type: "system-prompt", prompt: session.composed_system_prompt }];
      return { lines: [...prefix, ...jsonlLines], cursor: jsonlLines.length };
    },
  );
}
