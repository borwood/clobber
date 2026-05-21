import { describe, it, expect } from "bun:test";
import { RoleTriggerSchema, triggerId } from "../src/domain/role.ts";

describe("RoleTriggerSchema", () => {
  it("accepts a cron trigger with a valid expression", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "cron", expr: "0 9 * * *" });
    expect(result.success).toBe(true);
  });

  it("rejects a cron trigger with an empty expression", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "cron", expr: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a cron trigger missing the expr field", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "cron" });
    expect(result.success).toBe(false);
  });

  it("accepts a file-watch trigger with a glob", () => {
    const result = RoleTriggerSchema.safeParse({
      kind: "file-watch",
      glob: "src/**/*.ts",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a file-watch trigger with an empty glob", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "file-watch", glob: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a webhook trigger with a path", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "webhook", path: "/hooks/triage" });
    expect(result.success).toBe(true);
  });

  it("rejects a webhook trigger with a path that does not start with /", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "webhook", path: "hooks/triage" });
    expect(result.success).toBe(false);
  });

  it("accepts an issue-assigned trigger without a repo filter", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "issue-assigned" });
    expect(result.success).toBe(true);
  });

  it("accepts an issue-assigned trigger with a repo filter", () => {
    const result = RoleTriggerSchema.safeParse({
      kind: "issue-assigned",
      repo: "owner/name",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an issue-assigned trigger with an empty repo string", () => {
    const result = RoleTriggerSchema.safeParse({
      kind: "issue-assigned",
      repo: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown trigger kind", () => {
    const result = RoleTriggerSchema.safeParse({ kind: "smoke-signal", channel: "1" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing kind", () => {
    const result = RoleTriggerSchema.safeParse({ expr: "0 9 * * *" });
    expect(result.success).toBe(false);
  });
});

describe("triggerId — canonical id per trigger shape", () => {
  it("derives a stable id for a cron trigger", () => {
    expect(triggerId({ kind: "cron", expr: "0 9 * * *" })).toBe("cron:0 9 * * *");
  });

  it("derives a stable id for a webhook trigger", () => {
    expect(triggerId({ kind: "webhook", path: "/hooks/x" })).toBe("webhook:/hooks/x");
  });

  it("derives a stable id for a file-watch trigger", () => {
    expect(triggerId({ kind: "file-watch", glob: "src/**/*.ts" })).toBe(
      "file-watch:src/**/*.ts",
    );
  });

  it("derives a stable id for an issue-assigned trigger without a repo filter", () => {
    expect(triggerId({ kind: "issue-assigned" })).toBe("issue-assigned");
  });

  it("derives a stable id for an issue-assigned trigger with a repo filter", () => {
    expect(triggerId({ kind: "issue-assigned", repo: "owner/name" })).toBe(
      "issue-assigned:owner/name",
    );
  });
});
