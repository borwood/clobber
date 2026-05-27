// The session-start system prompt is composed in three layers (epic #209):
//   A — role-unique framing (identity header)
//   B — seeds: instance-specific context relocated off the opening user
//       message (workspace context, office continuity)
//   C — wake-program addon (empty until the wake-programs child #212 lands)
// The role's not-yet-decomposed static prompt rides alongside A as durable
// role framing. Empty layers drop out so the result has no stray separators.
export interface SystemPromptLayers {
  readonly framing: string;
  readonly rolePrompt: string;
  readonly seeds: readonly string[];
  readonly wakeProgramAddon: string;
}

export function composeSystemPrompt(layers: SystemPromptLayers): string {
  return [layers.framing, layers.rolePrompt, ...layers.seeds, layers.wakeProgramAddon]
    .filter((segment) => segment !== "")
    .join("\n\n");
}
