import { PassThrough } from "node:stream";
import type { SpawnedAgentInfo } from "../src/types.ts";

/**
 * Inert spawn result for tests that don't exercise the live-agent surface.
 * stdin discards writes; exited never resolves.
 */
export function stubSpawnedAgent(
  opts: { sessionId?: string; pid?: number } = {},
): SpawnedAgentInfo {
  const stdin = new PassThrough();
  stdin.resume();
  return {
    sessionId: opts.sessionId === undefined ? "stub" : opts.sessionId,
    pid: opts.pid === undefined ? 0 : opts.pid,
    exited: new Promise<number | null>(() => {}),
    stdin,
  };
}
