import { z } from "zod";

// Reasoning depth knob exposed by `claude --effort <level>`. Mirrors the
// upstream CLI's enum — kept in lockstep with what the runtime can pass through.
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// Stable short aliases the claude CLI accepts. Enumerating them gives fast,
// friendly local errors on typos. Full API names (claude-*) are also accepted
// and passed through to the CLI unmodified — don't hardcode them here, they go
// stale every release.
export const MODEL_ALIASES = [
  "default",
  "best",
  "opus",
  "sonnet",
  "haiku",
  "opus[1m]",
  "sonnet[1m]",
  "opusplan",
] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const ModelSchema = z.string().refine(
  (v) => (MODEL_ALIASES as readonly string[]).includes(v) || /^claude-/.test(v),
  { message: `model must be one of ${MODEL_ALIASES.join("|")}, or a full claude-* model name` },
);
export type Model = z.infer<typeof ModelSchema>;
