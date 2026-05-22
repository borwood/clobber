import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleSkill } from "@clobber/shared";

// Filesystem layout the engine reads when the manager (or any persistent
// role with the policy enabled) asks "what skills can I grant myself?":
//
//   <repo>/.clobber/skills/<skill-name>/SKILL.md
//
// Each subdirectory of `.clobber/skills/` that contains a SKILL.md file
// is one catalog entry. The directory name is the skill name; the file
// contents are the skill body (verbatim, frontmatter and all — the role
// system consumes the raw SKILL.md). Subdirectories without a SKILL.md
// are skipped (they may be drafts, fixtures, or per-skill helper files).
//
// The catalog is filesystem-only and stateless. Re-reads on every call
// are intentional — workspaces edit skills in their repo and expect the
// next list/grant call to reflect the change.
const CATALOG_SUBDIR = ".clobber/skills";

export function loadWorkspaceSkillCatalog(repoPath: string): RoleSkill[] {
  const dir = join(repoPath, CATALOG_SUBDIR);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const skills: RoleSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const body = readFileSync(skillPath, "utf8");
    skills.push({ name: entry.name, body });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
