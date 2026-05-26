import { z } from "zod";

// Per-workspace file-size policy. Same tagged-union shape as spawn-worktree /
// final-report-callback: a default-on variant carrying the line ceiling plus an
// opt-out variant, so future tuning (per-extension ceilings, glob excludes)
// plugs in additively (add a branch to the union + an arm to the resolver).
//
// "on" feeds the agent an advisory reminder via a PostToolUse hook when an
// Edit/Write pushes a code file past `max_lines`; the write always succeeds
// (Golden Rule 3 — surface loudly, don't gate). "off" silences it.
//
// Engine default is on at 300 lines, matching CLAUDE.md Golden Rule 4 — the
// soft rule agents previously discovered only at review (#190).
export const FileSizePolicyOffSchema = z.object({
  kind: z.literal("off"),
});

export const FileSizePolicyOnSchema = z.object({
  kind: z.literal("on"),
  max_lines: z.number().int().positive(),
});

export const FileSizePolicySchema = z.discriminatedUnion("kind", [
  FileSizePolicyOffSchema,
  FileSizePolicyOnSchema,
]);
export type FileSizePolicy = z.infer<typeof FileSizePolicySchema>;

export const DEFAULT_FILE_SIZE_POLICY: FileSizePolicy = {
  kind: "on",
  max_lines: 300,
};
