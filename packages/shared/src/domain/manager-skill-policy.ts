import { z } from "zod";
import { RoleSkillSchema } from "./role.ts";

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

// Response shape of GET /agent/self-skills. The catalog is filesystem-
// scanned at request time; the granted list is the calling role's
// current skills; the policy is the workspace's manager_skill_policy.
export const SelfSkillsListResponseSchema = z.object({
  policy: ManagerSkillPolicySchema,
  granted: z.array(RoleSkillSchema),
  catalog: z.array(RoleSkillSchema),
});
export type SelfSkillsListResponse = z.infer<typeof SelfSkillsListResponseSchema>;

// Response shape of POST /agent/self-skills and DELETE
// /agent/self-skills/:name. Both bump the role to a new version and
// return the post-mutation granted list.
export const SelfSkillsMutationResponseSchema = z.object({
  role_id: z.string().uuid(),
  version: z.number().int().positive(),
  granted: z.array(RoleSkillSchema),
});
export type SelfSkillsMutationResponse = z.infer<
  typeof SelfSkillsMutationResponseSchema
>;
