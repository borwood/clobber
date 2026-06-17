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
export const ManagerSkillPolicySchema = z
  .object({
    allow_self_grant: z
      .boolean()
      .meta({ title: "Allow self-grant", description: "May the manager grant skills to its own role?" }),
    allowed_skills: z
      .array(z.string().min(1))
      .refine((s) => new Set(s).size === s.length, {
        message: "allowed_skills must not contain duplicates",
      })
      .meta({ title: "Allowed skills", description: "Skills the manager may pull from the workspace catalog." }),
  })
  .meta({
    title: "Manager skill policy",
    description: "Governs whether the manager may grant itself skills, and which ones.",
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
// /agent/self-skills/:name. #414 — both ADVANCE THE GIT PIN (commit on the role
// branch, no new version row) and return the post-mutation granted list.
export const SelfSkillsMutationResponseSchema = z.object({
  role_id: z.string().uuid(),
  branch: z.string().min(1),
  sha: z.string().min(1),
  no_new_version: z.literal(true),
  granted: z.array(RoleSkillSchema),
});
export type SelfSkillsMutationResponse = z.infer<
  typeof SelfSkillsMutationResponseSchema
>;
