import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BrowseDirResponse } from "@clobber/shared";

interface BrowseQuery {
  readonly path?: string;
}

// GET /fs/browse?path=<absolute>
//
// Lists the immediate child directories of `path` (or $HOME if omitted) so
// the web folder-picker can walk the filesystem one level at a time without
// the user typing absolute paths by hand. Hidden directories (leading dot)
// are skipped — they clutter the picker and aren't where workspaces live.
// Files are omitted; the picker only navigates directories.
export function registerFsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: BrowseQuery }>("/fs/browse", async (request, reply) => {
    const raw = request.query.path;
    const target = raw === undefined || raw.length === 0 ? homedir() : raw;
    if (!isAbsolute(target)) {
      reply.code(400);
      return { error: "path must be absolute" };
    }
    const resolved = normalize(target);
    if (!existsSync(resolved)) {
      reply.code(404);
      return { error: "path does not exist" };
    }
    if (!statSync(resolved).isDirectory()) {
      reply.code(400);
      return { error: "path is not a directory" };
    }
    let dirents;
    try {
      dirents = readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
      reply.code(403);
      return { error: `cannot read directory: ${(err as Error).message}` };
    }
    const entries = dirents
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = resolved === "/" ? null : dirname(resolved);
    const response: BrowseDirResponse = { path: resolved, parent, entries };
    return response;
  });
}
