import { EffortLevelSchema, type EffortLevel, type Model } from "@clobber/shared";

// The curated model list the UI offers (the shared contract also accepts
// wider aliases and full `claude-*` ids; those stay CLI territory). One list
// feeds both the spawn panel and the composer's live dials.
export const MODEL_OPTIONS: readonly Model[] = ["opus", "sonnet", "haiku", "fable"];

export const EFFORT_LEVELS: readonly EffortLevel[] = EffortLevelSchema.options;
