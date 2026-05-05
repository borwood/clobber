import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { run } from "../src/main.ts";

function captureStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (c: Buffer) => out.push(c));
  stderr.on("data", (c: Buffer) => err.push(c));
  return {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
  };
}

async function helpFor(verb: string): Promise<string> {
  const s = captureStreams();
  // Note: --help short-circuits before env resolution, so we can pass empty env.
  const code = await run({
    argv: [verb, "--help"],
    env: {},
    stdout: s.stdout,
    stderr: s.stderr,
  });
  expect(code).toBe(0);
  return s.out();
}

const VERBS = [
  "whoami",
  "spawn",
  "agents",
  "kill",
  "transcript",
  "status",
  "ask",
  "roles",
] as const;

describe("clobber CLI — verb --help", () => {
  for (const verb of VERBS) {
    describe(`${verb} --help`, () => {
      it("starts with a usage: line that names the verb", async () => {
        const text = await helpFor(verb);
        const firstLine = text.split("\n")[0]!;
        expect(firstLine.toLowerCase()).toContain("usage:");
        expect(firstLine).toContain(verb);
      });

      it("includes a Flags: section (or notes there are no flags)", async () => {
        const text = await helpFor(verb);
        expect(text).toMatch(/Flags[^\n]*:|\(no flags\)/);
      });

      it("includes at least one Example:", async () => {
        const text = await helpFor(verb);
        expect(text).toMatch(/Example[s]?:/);
      });

      it("ends with a skill pointer", async () => {
        const text = await helpFor(verb);
        expect(text).toMatch(/skill/i);
      });
    });
  }
});
