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

// ── Custom themes (#370) ─────────────────────────────────────────────────────
// A custom theme is DATA, not code: a sparse map of semantic-role → CSS color,
// injected as inline `--color-*` vars at runtime (apply-theme.ts). No rebuild to
// add one (Golden Rule 3, engine-not-opinion).
//
// SemanticTokenSchema is the set of overridable role names. It MIRRORS the
// `--color-*` tokens declared in `packages/web/src/index.css`'s `@theme` block —
// the one place literal colors live. Keep the two in sync: a token here that
// isn't in the CSS paints nothing; a CSS token missing here can't be customized.
// Enumerating it (rather than `z.string()`) makes a typo'd token a parse error
// instead of a silent dead override.
export const SemanticTokenSchema = z.enum([
  "bg",
  "surface",
  "elevated",
  "raised",
  "border",
  "border-strong",
  "text",
  "text-dim",
  "text-soft",
  "text-muted",
  "text-subtle",
  "text-faint",
  "accent",
  "accent-strong",
  "accent-hover",
  "accent-text",
  "accent-fg",
  "accent-muted",
  "accent-deep",
  "working",
  "blocked",
  "done",
  "danger",
  "danger-strong",
  "danger-text",
  "danger-muted",
  "info",
  "info-strong",
  "info-text",
  "info-surface",
  "info-fg",
  "provenance",
  "provenance-fg",
  "provenance-text",
  "provenance-strong",
  "provenance-muted",
  "provenance-deep",
]);
export type SemanticToken = z.infer<typeof SemanticTokenSchema>;

// Surfaced for the per-token editor to render a row per role without re-listing
// the names (single source of truth = the schema).
export const SEMANTIC_TOKENS = SemanticTokenSchema.options;

// A custom token value lands directly in `documentElement.style` as a CSS value,
// so this is the injection trust boundary. Accept hex / rgb(a) / hsl(a) / oklch /
// oklab / lab / lch; the in-paren charset excludes letters (so `url` can't
// appear) and `;` (so a value can't break out into a second declaration).
export const CssColorSchema = z
  .string()
  .regex(
    /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[0-9.,%/\s+-]+\s*\))$/,
    "must be a hex, rgb(), or oklch() color (no ';' or url())",
  );
export type CssColor = z.infer<typeof CssColorSchema>;

// `base` is the provenance edge: the built-in mode this theme forks from. It
// makes the theme a SPARSE override (store only changed tokens; inherit the rest
// from base at apply time) and unlocks reset-to-base / diff / re-layer for free.
export const CustomThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  base: BuiltInModeSchema,
  accent: BuiltInAccentSchema.optional(),
  tokens: z.partialRecord(SemanticTokenSchema, CssColorSchema).default({}),
});
export type CustomTheme = z.infer<typeof CustomThemeSchema>;

// `mode` widens to a built-in OR a custom id. The refine keeps the selected mode
// RESOLVABLE: a string that's neither a built-in nor a defined custom id is a
// dangling pointer and is rejected at the persistence boundary — same
// no-silent-fallback contract the built-in enums carry (Engineering Rule 3). The
// apply layer re-checks at render time (it needs the def to paint).
export const WorkspaceThemeSchema = z
  .object({
    mode: z.union([BuiltInModeSchema, z.string().min(1)]),
    accent: BuiltInAccentSchema,
    custom: z.array(CustomThemeSchema).default([]),
  })
  .refine(
    (t) =>
      (BUILT_IN_MODES as readonly string[]).includes(t.mode) ||
      t.custom.some((c) => c.id === t.mode),
    {
      message: "selected mode must be a built-in mode or a defined custom theme id",
      path: ["mode"],
    },
  );
export type WorkspaceTheme = z.infer<typeof WorkspaceThemeSchema>;

export const DEFAULT_WORKSPACE_THEME: WorkspaceTheme = {
  mode: "dark",
  accent: "emerald",
  custom: [],
};
