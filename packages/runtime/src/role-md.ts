import { ROLE_FILE } from "@clobber/shared";

// #216 — the engine-versioned `ROLE.md` edit-spec body. Regenerated at every
// checkout, never round-tripped, so it is always current and identical across
// every role. Kept deliberately short: the per-file schemas live BESIDE the
// files, not here, so this can't drift on an engine change. The frontmatter
// codec (parse/render) lives in @clobber/shared next to the schema.
export function roleEditSpecBody(roleName: string): string {
  return `# You are editing a role working copy

This directory is a checkout of the **${roleName}** role's branch. Edit the files
below with normal tools, then \`clobber roles commit\` to serialize them back onto
the branch and advance the pin. \`clobber roles discard\` throws the checkout away.

| File | What it is |
|---|---|
| \`framing.md\` | Prompt layer A (role framing) |
| \`system-prompt.md\` | Prompt layer B (static prompt) |
| \`skills/<name>/SKILL.md\` | One skill (md + frontmatter), one dir per skill |
| \`seed-refs.json\` | Ordered layer-B seed refs (order = compose order) |
| \`wake-programs/<name>/{system,user}.md\` | A wake-program's layer-C + kick |
| \`triggers/<slug>.json\` | One trigger (persistent roles only) |
| \`allowed-tools.txt\` | Tool allow-list, one per line |
| \`allowed-cli-commands.txt\` | CLI allow-list, one per line |
| \`${ROLE_FILE}\` frontmatter | name / description / persistent / effort |

\`hooks.json\` is engine instrumentation — it is not in your checkout and is not
editable.
`;
}
