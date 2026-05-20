import type { RuntimeEvent } from "@clobber/runtime";
import type { SessionStore } from "./session-store.ts";
import type { SpawnedAgentInfo } from "./types.ts";

interface SessionEventSink {
  readonly sessions: SessionStore;
}

export function bindRuntimeEvents(
  deps: SessionEventSink,
  sessionId: string,
  spawned: SpawnedAgentInfo,
): void {
  if (spawned.runtimeEvents === undefined) return;
  void consumeRuntimeEvents(deps, sessionId, spawned.runtimeEvents);
}

async function consumeRuntimeEvents(
  deps: SessionEventSink,
  sessionId: string,
  events: AsyncIterable<RuntimeEvent>,
): Promise<void> {
  for await (const event of events) {
    if (event.kind === "provider-thread-started") {
      deps.sessions.updateProviderThreadId(sessionId, event.providerThreadId);
    }
  }
}
