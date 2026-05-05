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

describe("clobber CLI — root --version", () => {
  it("--version prints a version string and exits 0", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["--version"],
      env: {},
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("-V prints a version string and exits 0", async () => {
    const s = captureStreams();
    const code = await run({
      argv: ["-V"],
      env: {},
      stdout: s.stdout,
      stderr: s.stderr,
    });
    expect(code).toBe(0);
    expect(s.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// Direct parser tests — keep us honest that aliases route to identical parsed
// output, without spinning up a full HTTP harness.

import { parseSpawnArgs } from "../src/commands/spawn.ts";
import { parseStatusArgs } from "../src/commands/status.ts";
import { parseTranscriptFlags } from "../src/commands/transcript.ts";

describe("spawn parser — short aliases", () => {
  it("-p is an alias for --prompt", () => {
    const a = parseSpawnArgs(["worker", "--prompt", "do x", "--label", "lbl"]);
    const b = parseSpawnArgs(["worker", "-p", "do x", "--label", "lbl"]);
    expect(b).toEqual(a);
  });

  it("-l is an alias for --label", () => {
    const a = parseSpawnArgs(["worker", "--prompt", "do x", "--label", "lbl"]);
    const b = parseSpawnArgs(["worker", "--prompt", "do x", "-l", "lbl"]);
    expect(b).toEqual(a);
  });

  it("mixing short + long forms is fine", () => {
    const out = parseSpawnArgs(["worker", "-p", "x", "-l", "y"]);
    expect(out).toEqual({ role: "worker", prompt: "x", label: "y" });
  });
});

describe("status parser — -m alternative to positional summary", () => {
  it("-m sets the summary", () => {
    const out = parseStatusArgs(["working", "-m", "drafting #34"]);
    expect(out.summary).toBe("drafting #34");
    expect(out.state).toBe("working");
  });

  it("positional summary still works", () => {
    const out = parseStatusArgs(["working", "drafting #34"]);
    expect(out.summary).toBe("drafting #34");
  });

  it("rejects when both positional and -m are provided", () => {
    expect(() =>
      parseStatusArgs(["working", "summary", "-m", "other"]),
    ).toThrow(/both/i);
  });
});

describe("transcript parser — selector and format aliases", () => {
  it("--tail is an alias for --last", () => {
    const a = parseTranscriptFlags(["sid", "--last", "5"]);
    const b = parseTranscriptFlags(["sid", "--tail", "5"]);
    expect(b).toEqual(a);
  });

  it("-n is an alias for --last", () => {
    const a = parseTranscriptFlags(["sid", "--last", "10"]);
    const b = parseTranscriptFlags(["sid", "-n", "10"]);
    expect(b).toEqual(a);
  });

  it("--json is shorthand for --format json", () => {
    const a = parseTranscriptFlags(["sid", "--format", "json"]);
    const b = parseTranscriptFlags(["sid", "--json"]);
    expect(b).toEqual(a);
  });

  it("rejects mixing --last and --tail (both selectors)", () => {
    expect(() =>
      parseTranscriptFlags(["sid", "--last", "5", "--tail", "3"]),
    ).toThrow(/selector/i);
  });

  it("rejects mixing -n and --entry (both selectors)", () => {
    expect(() =>
      parseTranscriptFlags(["sid", "-n", "5", "--entry", "abc"]),
    ).toThrow(/selector/i);
  });
});
