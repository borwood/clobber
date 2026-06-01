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

export const FileReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;

export const SessionLocationsResponseSchema = z.object({
  desk_path: z.string(),
  office_path: z.string().nullable(),
});
export type SessionLocationsResponse = z.infer<typeof SessionLocationsResponseSchema>;
