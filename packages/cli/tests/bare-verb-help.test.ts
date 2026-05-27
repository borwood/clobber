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

async function bare(verb: string) {
  const s = captureStreams();
  const code = await run({
    argv: [verb],
    env: {},
    stdout: s.stdout,
    stderr: s.stderr,
  });
  return { code, out: s.out(), err: s.err() };
}

// Verbs that have subcommands: bare invocation must print that verb's help and exit 0.
const SUBCOMMAND_VERBS = [
  "roles",
  "agents",
  "reports",
  "self-skills",
  "workspace",
] as const;

describe("clobber CLI — bare subcommand-bearing verb prints help, exits 0", () => {
  for (const verb of SUBCOMMAND_VERBS) {
    describe(`bare ${verb}`, () => {
      it("exits 0", async () => {
        const { code } = await bare(verb);
        expect(code).toBe(0);
      });

      it("prints a usage: line naming the verb on stdout", async () => {
        const { out } = await bare(verb);
        const firstLine = out.split("\n")[0]!;
        expect(firstLine.toLowerCase()).toContain("usage:");
        expect(firstLine).toContain(verb);
      });
    });
  }
});

describe("clobber CLI — direct-arg verbs unaffected by bare-verb help", () => {
  // `kill` takes a direct arg (a session id), not a subcommand. Bare invocation
  // must NOT short-circuit to help+0; it proceeds into the command (and here
  // fails env resolution), demonstrating it is left as-is.
  it("does not turn bare `kill` into help+exit-0", async () => {
    const s = captureStreams();
    await expect(
      run({ argv: ["kill"], env: {}, stdout: s.stdout, stderr: s.stderr }),
    ).rejects.toThrow();
  });
});
