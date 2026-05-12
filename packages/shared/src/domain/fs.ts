import { z } from "zod";

export const DirEntrySchema = z.object({
  name: z.string(),
  isDir: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const BrowseDirResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(DirEntrySchema),
});
export type BrowseDirResponse = z.infer<typeof BrowseDirResponseSchema>;
