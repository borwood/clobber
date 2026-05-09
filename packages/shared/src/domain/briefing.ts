import { z } from "zod";

const BriefingFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.startsWith("/"), {
    message: "must be a relative path (no leading '/')",
  })
  .refine((s) => !s.split("/").includes(".."), {
    message: "must not contain '..' segments",
  })
  .refine((s) => !s.includes("\0"), {
    message: "must not contain NUL bytes",
  });

export const BriefingFileSchema = z.object({
  name: BriefingFileNameSchema,
  content: z.string(),
});
export type BriefingFile = z.infer<typeof BriefingFileSchema>;

export const BriefingPacketSchema = z
  .object({
    files: z.array(BriefingFileSchema).max(64),
  })
  .refine(
    (p) => new Set(p.files.map((f) => f.name)).size === p.files.length,
    { message: "briefing file names must be unique", path: ["files"] },
  );
export type BriefingPacket = z.infer<typeof BriefingPacketSchema>;
