import { z } from "zod";

// Synthetic "This PC" path: a platform-neutral sentinel the dir picker browses
// to enumerate mounted drive roots (Windows C:\, B:\, …). On POSIX there is a
// single root (/) so this level is never surfaced; on Windows it sits one step
// above any drive root so ↑ can hop between volumes.
export const DRIVES_ROOT = "::drives::";

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
