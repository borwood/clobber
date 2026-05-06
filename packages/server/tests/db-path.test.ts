import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveDatabasePath } from "../src/db-path.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const FAKE_INDEX_URL = `file://${REPO_ROOT}/packages/server/src/index.ts`;

describe("resolveDatabasePath", () => {
  it("defaults to <repo-root>/clobber.db when no env value", () => {
    const result = resolveDatabasePath({
      envValue: undefined,
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/anywhere",
    });
    expect(result).toBe(resolve(REPO_ROOT, "clobber.db"));
  });

  it("treats empty env value as unset and falls back to repo root", () => {
    const result = resolveDatabasePath({
      envValue: "",
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/anywhere",
    });
    expect(result).toBe(resolve(REPO_ROOT, "clobber.db"));
  });

  it("returns absolute env paths verbatim", () => {
    const result = resolveDatabasePath({
      envValue: "/tmp/custom.db",
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/anywhere",
    });
    expect(result).toBe("/tmp/custom.db");
  });

  it("resolves relative env paths against cwd, not against repo root", () => {
    const result = resolveDatabasePath({
      envValue: "./mine.db",
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/some/cwd",
    });
    expect(result).toBe("/some/cwd/mine.db");
  });

  it("passes :memory: through unchanged (sqlite in-memory marker, not a path)", () => {
    const result = resolveDatabasePath({
      envValue: ":memory:",
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/anywhere",
    });
    expect(result).toBe(":memory:");
  });

  it("ignores cwd when env is unset — repo-root anchor is stable", () => {
    const a = resolveDatabasePath({
      envValue: undefined,
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/cwd/one",
    });
    const b = resolveDatabasePath({
      envValue: undefined,
      serverIndexUrl: FAKE_INDEX_URL,
      cwd: "/cwd/two",
    });
    expect(a).toBe(b);
  });
});
