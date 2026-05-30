import { z } from "zod";

// Per-workspace theme. Sibling to file-size-policy: a small zod-file the config
// rails (DB column, store round-trip, PATCH route, settings modal) ride on.
//
// Mode and accent are ORTHOGONAL axes: `3 modes × N accents` combinations come
// from `3 + N` definitions, not a flat list of every pairing. The CSS layer
// (index.css) re-points the semantic tokens per `[data-theme]` (mode → surfaces
// / text / status contrast) and per `[data-accent]` (accent → accent ramp only),
// so a component never knows which mode or accent it renders under.
//
// Unknown stored mode/accent THROWS at parse — no silent fallback to dark
// (Engineering Rule 3 / the simplest-fallback trap). The default is a real value
// the migration backfills, not a parse-time rescue.
//
// Custom/user-defined themes (a `custom` array + CustomThemeSchema) arrive in
// Issue C (#370); the object stays open to that extension without building it
// here.
export const BuiltInModeSchema = z.enum(["dark", "light", "paper"]);
export type BuiltInMode = z.infer<typeof BuiltInModeSchema>;

export const BuiltInAccentSchema = z.enum([
  "emerald",
  "blue",
  "violet",
  "amber",
  "rose",
]);
export type BuiltInAccent = z.infer<typeof BuiltInAccentSchema>;

// The enumerated options, surfaced for the settings UI to render selectors over
// without re-declaring the lists (single source of truth = the schema).
export const BUILT_IN_MODES = BuiltInModeSchema.options;
export const BUILT_IN_ACCENTS = BuiltInAccentSchema.options;

export const WorkspaceThemeSchema = z.object({
  mode: BuiltInModeSchema,
  accent: BuiltInAccentSchema,
});
export type WorkspaceTheme = z.infer<typeof WorkspaceThemeSchema>;

export const DEFAULT_WORKSPACE_THEME: WorkspaceTheme = {
  mode: "dark",
  accent: "emerald",
};
