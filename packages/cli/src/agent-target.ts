import type { CliEnv } from "./env.ts";
import { request } from "./http.ts";
import { CliUsageError } from "./usage-error.ts";

export type AgentState = "busy" | "idle" | "ended";

interface ListedAgent {
  readonly session_id: string;
  readonly label?: string;
  readonly state: AgentState;
}

interface AgentsListResponse {
  readonly agents: readonly ListedAgent[];
}

// A token shorter than this is treated as a label, never a session-id prefix —
// a 1-3 char prefix would collide with half the floor for no ergonomic gain.
const PREFIX_FLOOR = 4;

/**
 * Resolve a user-supplied agent target — a label, a full session id, or a
 * session-id prefix — to a single session id, querying the server's live agent
 * list restricted to `eligibleStates` (the states the calling command can act
 * on). A full session id is unambiguous on its own; otherwise label and prefix
 * matches are unioned and any collision rejects the command so the caller
 * retries with a session id.
 */
export async function resolveAgentTarget(
  env: CliEnv,
  target: string,
  eligibleStates: readonly AgentState[],
): Promise<string> {
  const { agents } = await request<AgentsListResponse>(env, {
    method: "GET",
    path: `/agent/agents?states=${encodeURIComponent(eligibleStates.join(","))}`,
  });

  const exact = agents.find((a) => a.session_id === target);
  if (exact !== undefined) return exact.session_id;

  const matches = agents.filter(
    (a) =>
      a.label === target ||
      (target.length >= PREFIX_FLOOR && a.session_id.startsWith(target)),
  );

  if (matches.length === 0) {
    throw new CliUsageError(`no such agent: '${target}'`);
  }
  if (matches.length > 1) {
    const pairs = matches
      .map((a) => `  ${a.label ?? "(no label)"} : ${a.session_id}`)
      .join("\n");
    throw new CliUsageError(
      `multiple agents match '${target}' — retry with a session-id:\n${pairs}`,
    );
  }
  return matches[0]!.session_id;
}
