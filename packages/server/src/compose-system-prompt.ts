import { CLOBBER_TAG_INTERPRETATION_GUIDANCE } from "@clobber/shared";

// The session-start system prompt is composed in four layers (epic #209):
//   A — role-unique framing (identity header), preceded by standing clobber
//       runtime guidance that every session needs (e.g. how to read
//       `<clobber type=…>` user-turn wrappers, #262)
//   B — seeds: instance-specific context relocated off the opening user
//       message (workspace context, office continuity)
//   op — op-level addon: structural context injected by the operation that
//        started this session (e.g. cycle orientation, #502). Absent for
//        plain spawn; represented as "" and filtered out.
//   C — wake-program addon: role/dispatch-selected opening-move addon
// The role's not-yet-decomposed static prompt rides alongside A as durable
// role framing. Empty layers drop out so the result has no stray separators.
export interface SystemPromptLayers {
  readonly framing: string;
  readonly rolePrompt: string;
  readonly seeds: readonly string[];
  // Op-level addon injected by the triggering operation (e.g. cycle). Pass ""
  // (the canonical empty value) when no op-level addon applies — never use null
  // or undefined here; the absent-op-layer is an expected, normal state.
  readonly opLevelAddon: string;
  readonly wakeProgramAddon: string;
}

export function composeSystemPrompt(layers: SystemPromptLayers): string {
  return [
    CLOBBER_TAG_INTERPRETATION_GUIDANCE,
    layers.framing,
    layers.rolePrompt,
    ...layers.seeds,
    layers.opLevelAddon,
    layers.wakeProgramAddon,
  ]
    .filter((segment) => segment !== "")
    .join("\n\n");
}
