// Generic helpers for the "indexed event source" pattern used by webhook and
// workspace-open triggers: each scheduled entry is reachable both by agent id
// (so we can clear a specific agent on reload) and by an event-key (path for
// webhooks, workspace id for workspace-open) so the fire path is O(matches).

export function addToKeyedIndex<T>(
  entry: T,
  agentId: string,
  key: string,
  byAgent: Map<string, Set<T>>,
  byKey: Map<string, Set<T>>,
): void {
  let agentSet = byAgent.get(agentId);
  if (agentSet === undefined) {
    agentSet = new Set<T>();
    byAgent.set(agentId, agentSet);
  }
  agentSet.add(entry);
  let keySet = byKey.get(key);
  if (keySet === undefined) {
    keySet = new Set<T>();
    byKey.set(key, keySet);
  }
  keySet.add(entry);
}

export function clearAgentFromKeyedIndex<T>(
  agentId: string,
  keyOf: (entry: T) => string,
  byAgent: Map<string, Set<T>>,
  byKey: Map<string, Set<T>>,
): void {
  const entries = byAgent.get(agentId);
  if (entries === undefined) return;
  for (const entry of entries) {
    const k = keyOf(entry);
    const set = byKey.get(k);
    if (set === undefined) continue;
    set.delete(entry);
    if (set.size === 0) byKey.delete(k);
  }
  byAgent.delete(agentId);
}
