import type { SpawnedAgentInfo } from "./types.ts";

export type RuntimeStartupResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

export async function waitForRuntimeStartup(
  spawned: SpawnedAgentInfo,
): Promise<RuntimeStartupResult> {
  if (spawned.startup === undefined) return { ok: true };
  return spawned.startup;
}

export function isProviderThreadMissing(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("provider thread not found") ||
    normalized.includes("thread not found") ||
    normalized.includes("session not found") ||
    normalized.includes("no rollout found") ||
    normalized.includes("no such session")
  );
}
