import type { RuntimeProvider } from "@clobber/runtime";
import type { ClobberPromptTag } from "@clobber/shared";
import type { LiveAgent } from "./agent-registry.ts";
import type { AgentRegistry } from "./agent-registry.ts";

// Shared stdin-injection primitive: serialize body+tag, write to the live
// child's stdin, and mark the session busy. Both deliver() and injectPrompt
// called byte-identical code; this extracts it so there is one impl (GR1).
//
// Safe mid-turn: claude's native stdin queue defers a mid-thinking write to a
// safe tool-result boundary on its own (#367 spike — 14/14, never poisons).
export function writeUserTurn(
  live: LiveAgent,
  runtimeProvider: RuntimeProvider,
  registry: AgentRegistry,
  body: string,
  tag?: ClobberPromptTag,
): void {
  live.stdin.write(runtimeProvider.serializeUserPrompt(body, tag));
  registry.setBusy(live.sessionId, true);
}
