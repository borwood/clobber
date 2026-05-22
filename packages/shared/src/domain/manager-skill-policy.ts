import { z } from "zod";

// Per-workspace policy governing whether a persistent agent (the manager)
// may grant skills to its own role. The engine ships zero opinion: by
// default no self-grant is permitted, and the allowed-skill list is empty.
// Workspaces opt in by raising the policy and naming the skills the manager
// may pull from the workspace's skill catalog (`<repo>/.clobber/skills/`).
//
// `allowed_skills` is forward-compat: glob or prefix matching is a
// plausible follow-up. v1 is exact match by name.
export const ManagerSkillPolicySchema = z.object({
  allow_self_grant: z.boolean(),
  allowed_skills: z.array(z.string().min(1)).refine(
    (s) => new Set(s).size === s.length,
    { message: "allowed_skills must not contain duplicates" },
  ),
});
export type ManagerSkillPolicy = z.infer<typeof ManagerSkillPolicySchema>;

export const DEFAULT_MANAGER_SKILL_POLICY: ManagerSkillPolicy = {
  allow_self_grant: false,
  allowed_skills: [],
};
