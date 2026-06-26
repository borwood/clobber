import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, isAbsolute, normalize } from "node:path";
import type { FastifyInstance } from "fastify";
import { DRIVES_ROOT, type BrowseDirResponse, type FileReadResponse } from "@clobber/shared";

interface BrowseQuery {
  readonly path?: string;
  readonly includeFiles?: string;
}

interface ReadQuery {
  readonly path?: string;
}

// Seams for testing platform-specific behavior on any host (the route's drive
// logic only fires on Windows, but CI runs on POSIX).
export interface FsRoutesOptions {
  readonly platform?: NodeJS.Platform;
  // Enumerate mounted drive roots ("C:\\", "B:\\", …). Defaults to scanning A–Z.
  readonly listDrives?: () => readonly string[];
  // True when `path` is a drive/filesystem root — i.e. it has no real parent.
  readonly isRoot?: (path: string) => boolean;
}

function scanDrives(): string[] {
  const drives: string[] = [];
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

// GET /fs/browse?path=<absolute>[&includeFiles=true]
//
// Lists the immediate children of `path` (or $HOME if omitted). By default
// lists only directories (the new-workspace folder-picker behavior). Pass
// `includeFiles=true` to include files alongside dirs — used by the desk/
// office file browser. Hidden entries (leading dot) are omitted in both modes.
//
// On Windows, `path=<DRIVES_ROOT>` returns the synthetic "This PC" level: a
// listing of mounted drive roots so the picker can cross between volumes. A
// drive root reports `DRIVES_ROOT` as its parent so ↑ climbs into that list.
export function registerFsRoutes(app: FastifyInstance, options: FsRoutesOptions = {}): void {
  const isWindows = (options.platform ?? osPlatform()) === "win32";
  const listDrives = options.listDrives ?? scanDrives;
  const isRoot = options.isRoot ?? ((p: string) => dirname(p) === p);

  app.get<{ Querystring: BrowseQuery }>("/fs/browse", async (request, reply) => {
    const raw = request.query.path;

    if (isWindows && raw === DRIVES_ROOT) {
      const entries = listDrives()
        .map((name) => ({ name, isDir: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const response: BrowseDirResponse = { path: DRIVES_ROOT, parent: null, entries };
      return response;
    }

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
    const parent = isRoot(resolved) ? (isWindows ? DRIVES_ROOT : null) : dirname(resolved);
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
