import { z } from "zod";
import { HookPayloadSchema } from "../hooks/payloads.ts";

const HookEventNameSchema = z.enum(
  HookPayloadSchema.options.map((opt) => opt.shape.hook_event_name.value) as [
    string,
    ...string[],
  ],
);

const RelativeBundlePath = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("/"), {
    message: "must be a relative path (no leading '/')",
  })
  .refine((s) => !s.split("/").includes(".."), {
    message: "must not contain '..' segments",
  });

export const RoleSkillEntrySchema = z.object({
  name: z.string().min(1),
  path: RelativeBundlePath,
});
export type RoleSkillEntry = z.infer<typeof RoleSkillEntrySchema>;

export const RoleHookScriptEntrySchema = z.object({
  event: HookEventNameSchema,
  path: RelativeBundlePath,
});
export type RoleHookScriptEntry = z.infer<typeof RoleHookScriptEntrySchema>;

export const RoleManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    systemPromptPath: RelativeBundlePath,
    allowedCliCommands: z.array(z.string().min(1)).readonly(),
    settingsOverlayPath: RelativeBundlePath,
    skills: z.array(RoleSkillEntrySchema).readonly(),
    hookScripts: z.array(RoleHookScriptEntrySchema).readonly(),
  })
  .refine(
    (m) => new Set(m.skills.map((s) => s.name)).size === m.skills.length,
    { message: "skill names must be unique", path: ["skills"] },
  )
  .refine(
    (m) =>
      new Set(m.allowedCliCommands).size === m.allowedCliCommands.length,
    { message: "allowedCliCommands must be unique", path: ["allowedCliCommands"] },
  );
export type RoleManifest = z.infer<typeof RoleManifestSchema>;
