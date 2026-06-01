import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerFsRoutes } from "../src/routes/fs.ts";
import type { BrowseDirResponse, FileReadResponse } from "@clobber/shared";

let app: ReturnType<typeof Fastify>;
let scratch: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "clobber-fs-browse-"));
  app = Fastify({ logger: false });
  registerFsRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("GET /fs/browse", () => {
  it("lists immediate child directories of an absolute path", async () => {
    mkdirSync(join(scratch, "alpha"));
    mkdirSync(join(scratch, "bravo"));
    mkdirSync(join(scratch, "charlie"));

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(scratch)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.path).toBe(scratch);
    expect(body.entries.map((e) => e.name)).toEqual(["alpha", "bravo", "charlie"]);
    for (const e of body.entries) expect(e.isDir).toBe(true);
  });

  it("omits files from the listing — picker only navigates directories", async () => {
    mkdirSync(join(scratch, "subdir"));
    writeFileSync(join(scratch, "README.md"), "hi");
    writeFileSync(join(scratch, "package.json"), "{}");

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(scratch)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.entries.map((e) => e.name)).toEqual(["subdir"]);
  });

  it("omits hidden directories (leading dot) by default", async () => {
    mkdirSync(join(scratch, "visible"));
    mkdirSync(join(scratch, ".hidden"));
    mkdirSync(join(scratch, ".git"));

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(scratch)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.entries.map((e) => e.name)).toEqual(["visible"]);
  });

  it("returns the parent directory so the picker can render an 'up' affordance", async () => {
    mkdirSync(join(scratch, "child"));
    const target = join(scratch, "child");

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(target)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.parent).toBe(scratch);
  });

  it("returns parent=null for the filesystem root", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/browse?path=/" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.path).toBe("/");
    expect(body.parent).toBeNull();
  });

  it("defaults to $HOME when path is omitted so the picker can open cold", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/browse" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.path.length).toBeGreaterThan(0);
    expect(body.path.startsWith("/")).toBe(true);
  });

  it("returns 400 when the path is not absolute", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/fs/browse?path=relative%2Fdir",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/absolute/);
  });

  it("returns 404 when the path does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent("/does/not/exist/anywhere-12345")}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the path points at a file, not a directory", async () => {
    const filePath = join(scratch, "not-a-dir.txt");
    writeFileSync(filePath, "hello");
    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(filePath)}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/directory/);
  });

  it("includeFiles=true returns files alongside dirs with correct isDir flag", async () => {
    mkdirSync(join(scratch, "subdir"));
    writeFileSync(join(scratch, "readme.md"), "hello");
    writeFileSync(join(scratch, "notes.txt"), "world");

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(scratch)}&includeFiles=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("subdir");
    expect(names).toContain("readme.md");
    expect(names).toContain("notes.txt");
    const subdir = body.entries.find((e) => e.name === "subdir")!;
    expect(subdir.isDir).toBe(true);
    const readme = body.entries.find((e) => e.name === "readme.md")!;
    expect(readme.isDir).toBe(false);
  });

  it("default (no includeFiles param) remains dir-only — files not returned", async () => {
    mkdirSync(join(scratch, "subdir"));
    writeFileSync(join(scratch, "readme.md"), "hello");

    const res = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(scratch)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BrowseDirResponse;
    expect(body.entries.map((e) => e.name)).toEqual(["subdir"]);
  });
});

describe("GET /fs/read", () => {
  it("returns the text content of a file", async () => {
    const filePath = join(scratch, "brief.md");
    writeFileSync(filePath, "# Hello\nworld");

    const res = await app.inject({
      method: "GET",
      url: `/fs/read?path=${encodeURIComponent(filePath)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FileReadResponse;
    expect(body.path).toBe(filePath);
    expect(body.content).toBe("# Hello\nworld");
  });

  it("returns 400 when path is not absolute", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/fs/read?path=relative.txt",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/absolute/);
  });

  it("returns 404 when the file does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/read?path=${encodeURIComponent("/does/not/exist.txt")}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the path is a directory, not a file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/fs/read?path=${encodeURIComponent(scratch)}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/file/);
  });
});
