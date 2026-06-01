import { z } from "zod";
import { EffortLevelSchema, ModelSchema, RoleNameSchema } from "./role.ts";

// #216 — the `ROLE.md` sidecar codec. A role's checkout root carries a `ROLE.md`
// with YAML-style frontmatter (the role's canonical, per-role metadata) above an
// engine-generated edit-spec body. The frontmatter is the only part that
// round-trips through a commit; the body is REGENERATED at checkout from the
// engine template (Q1) so the edit-spec never drifts and lives in one place.
//
// `ROLE.md` is a SIDECAR: it is not part of `RoleTreeContract`, so the
// embodiment deserializer ignores it and every pre-#216 commit deserializes
// unchanged (the regression invariant). It exists purely to make the role's
// index metadata editable in the working copy and to re-sync the `roles` row on
// commit.
//
// Clobber ships no YAML parser (SKILL.md frontmatter is opaque passthrough), and
// this frontmatter is a fixed, tiny schema — so it is parsed as `key: value`
// lines into a zod object, typed and validated, with no general-YAML surface.

export const ROLE_FILE = "ROLE.md";

export const RoleEditManifestSchema = z
  .object({
    name: RoleNameSchema,
    description: z.string().min(1),
    persistent: z.boolean(),
    // Optional: absent when the role predates the effort field or has no explicit
    // reasoning depth set. Omitted from the frontmatter when unset so an
    // effort-less ROLE.md round-trips unchanged (mirrors model below).
    effort: EffortLevelSchema.optional(),
    // Optional: unset = no role-default model = today's behavior.
    // Absent from the frontmatter when the role pins no model; the render below
    // omits the line entirely so a model-less ROLE.md round-trips unchanged.
    model: ModelSchema.optional(),
  })
  .strict();

export type RoleEditManifest = z.infer<typeof RoleEditManifestSchema>;

const FENCE = "---";

// Render the manifest as a `ROLE.md` file: frontmatter fence + the given body.
export function renderRoleManifest(manifest: RoleEditManifest, body: string): string {
  const validated = RoleEditManifestSchema.parse(manifest);
  const lines = [
    `name: ${validated.name}`,
    `description: ${validated.description}`,
    `persistent: ${validated.persistent}`,
  ];
  if (validated.effort !== undefined) lines.push(`effort: ${validated.effort}`);
  if (validated.model !== undefined) lines.push(`model: ${validated.model}`);
  const frontmatter = lines.join("\n");
  return `${FENCE}\n${frontmatter}\n${FENCE}\n\n${body}`;
}

// Parse a `ROLE.md` file's frontmatter into a typed manifest. The body is
// discarded — only the frontmatter is canonical. Malformed input throws (no
// defensive coercion): a missing fence, an unknown key, a non-slug name, or an
// out-of-enum effort all fail-fast so a bad commit is refused, not silently
// repaired.
export function parseRoleManifest(content: string): RoleEditManifest {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    throw new Error(`${ROLE_FILE} must open with a '${FENCE}' frontmatter fence`);
  }
  const closeIdx = lines.indexOf(FENCE, 1);
  if (closeIdx === -1) {
    throw new Error(`${ROLE_FILE} frontmatter is not closed by a '${FENCE}' fence`);
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    if (line.trim().length === 0) continue;
    const sep = line.indexOf(":");
    if (sep === -1) {
      throw new Error(`${ROLE_FILE} frontmatter line is not 'key: value': ${line}`);
    }
    const key = line.slice(0, sep).trim();
    raw[key] = line.slice(sep + 1).trim();
  }

  return RoleEditManifestSchema.parse({
    name: raw["name"],
    description: raw["description"],
    persistent: parseBool(raw["persistent"]),
    // Absent when the role predates the effort field — `.optional()` accepts
    // undefined, so a pre-effort frontmatter (no `effort:` line) parses unchanged.
    ...(raw["effort"] === undefined ? {} : { effort: raw["effort"] }),
    // Absent when the role pins no model — `.optional()` accepts undefined, so a
    // pre-#423 frontmatter (no `model:` line) parses unchanged.
    ...(raw["model"] === undefined ? {} : { model: raw["model"] }),
  });
}

// `persistent` is a typed boolean; only the two literals are valid. Anything
// else (including undefined) yields a value zod rejects, so the manifest schema
// surfaces one clear error rather than this helper guessing.
function parseBool(value: string | undefined): boolean | string | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
