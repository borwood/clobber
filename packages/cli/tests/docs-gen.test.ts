import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { generateDocs } from "../scripts/docs-gen.ts";
import { buildCommandRegistry, run } from "../src/main.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const COMMITTED_DOCS = join(REPO_ROOT, "docs");

async function collectFiles(dir: string, base: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath, base)));
    } else {
      results.push(relative(base, fullPath));
    }
  }
  return results.sort();
}

async function captureRun(
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stderr.on("data", (c: Buffer) => err.push(c));
  const code = await run({
    argv,
    env: {},
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
  });
  return { code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") };
}

describe("docs:gen — idempotency", () => {
  it("generates byte-identical output on two consecutive runs", async () => {
    const dir1 = await mkdtemp(join(tmpdir(), "clobber-docs-a-"));
    const dir2 = await mkdtemp(join(tmpdir(), "clobber-docs-b-"));
    try {
      await generateDocs(dir1);
      await generateDocs(dir2);

      const files1 = await collectFiles(dir1);
      const files2 = await collectFiles(dir2);
      expect(files2).toEqual(files1);

      for (const f of files1) {
        const a = await readFile(join(dir1, f));
        const b = await readFile(join(dir2, f));
        expect(b.equals(a)).toBe(true);
      }
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("matches the committed docs/ tree on a fixed commit", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "clobber-docs-check-"));
    try {
      await generateDocs(tmpDir);
      // Compares every generator-produced file against its committed counterpart.
      // Extra hand-authored files in docs/ (architecture/, runbooks/) are out of scope.
      const generatedFiles = await collectFiles(tmpDir);
      for (const f of generatedFiles) {
        const generated = await readFile(join(tmpDir, f));
        const committed = await readFile(join(COMMITTED_DOCS, f));
        expect(generated.equals(committed)).toBe(true);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("docs:gen — divergence (single source of truth)", () => {
  it("a verb's summary from buildCommandRegistry() appears verbatim in clobber --help", async () => {
    const cmd = buildCommandRegistry()
      .list()
      .find((c) => c.name === "status");
    if (cmd === undefined) throw new Error("status command missing from registry");
    const { out } = await captureRun(["--help"]);
    expect(out).toContain(cmd.summary);
  });

  it("a verb's summary from buildCommandRegistry() appears verbatim in the generated CLI index", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "clobber-docs-div-"));
    try {
      await generateDocs(tmpDir);
      const cliIndex = await readFile(join(tmpDir, "cli/index.md"), "utf8");
      const cmd = buildCommandRegistry()
        .list()
        .find((c) => c.name === "status");
      if (cmd === undefined) throw new Error("status command missing from registry");
      expect(cliIndex).toContain(cmd.summary);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
