import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BrowseDirResponse, FileReadResponse } from "@clobber/shared";

interface BrowseQuery {
  readonly path?: string;
  readonly includeFiles?: string;
}

interface ReadQuery {
  readonly path?: string;
}

// GET /fs/browse?path=<absolute>[&includeFiles=true]
//
// Lists the immediate children of `path` (or $HOME if omitted). By default
// lists only directories (the new-workspace folder-picker behavior). Pass
// `includeFiles=true` to include files alongside dirs — used by the desk/
// office file browser. Hidden entries (leading dot) are omitted in both modes.
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
    const withFiles = request.query.includeFiles === "true";
    const entries = dirents
      .filter((e) => !e.name.startsWith(".") && (withFiles ? e.isDirectory() || e.isFile() : e.isDirectory()))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const parent = resolved === "/" ? null : dirname(resolved);
    const response: BrowseDirResponse = { path: resolved, parent, entries };
    return response;
  });

  // GET /fs/read?path=<absolute>
  //
  // Returns the UTF-8 text content of a file so the desk/office viewer can
  // display it in-UI. Path must be absolute and point to a file, not a dir.
  app.get<{ Querystring: ReadQuery }>("/fs/read", async (request, reply) => {
    const raw = request.query.path;
    if (raw === undefined || raw.length === 0) {
      reply.code(400);
      return { error: "path must be absolute" };
    }
    if (!isAbsolute(raw)) {
      reply.code(400);
      return { error: "path must be absolute" };
    }
    const resolved = normalize(raw);
    if (!existsSync(resolved)) {
      reply.code(404);
      return { error: "path does not exist" };
    }
    if (!statSync(resolved).isFile()) {
      reply.code(400);
      return { error: "path is not a file" };
    }
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch (err) {
      reply.code(403);
      return { error: `cannot read file: ${(err as Error).message}` };
    }
    const response: FileReadResponse = { path: resolved, content };
    return response;
  });
}
