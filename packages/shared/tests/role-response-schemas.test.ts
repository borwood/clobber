import { describe, it, expect } from "bun:test";
import {
  RoleListEntrySchema,
  RoleDetailResponseSchema,
} from "../src/domain/role.ts";

const UUID_A = "17b74d99-e53d-4442-abc1-eabfd62eacc8";
const UUID_B = "75fe3caa-3854-477a-b08a-74e9ad0cd039";

describe("RoleListEntrySchema", () => {
  it("accepts a minimal list entry without optional fields", () => {
    const result = RoleListEntrySchema.safeParse({
      id: UUID_A,
      name: "worker",
      persistent: false,
      current_version_id: UUID_B,
      version: 1,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts description and allowed_tools when present", () => {
    const result = RoleListEntrySchema.safeParse({
      id: UUID_A,
      name: "worker",
      persistent: false,
      description: "Generic worker.",
      allowed_tools: ["Bash", "Edit"],
      current_version_id: UUID_B,
      version: 1,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an entry missing current_version_id", () => {
    const result = RoleListEntrySchema.safeParse({
      id: UUID_A,
      name: "worker",
      persistent: false,
      version: 1,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive version", () => {
    const result = RoleListEntrySchema.safeParse({
      id: UUID_A,
      name: "worker",
      persistent: false,
      current_version_id: UUID_B,
      version: 0,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(false);
  });
});

describe("RoleDetailResponseSchema", () => {
  const baseDetail = {
    id: UUID_A,
    name: "worker",
    persistent: false,
    current_version: {
      id: UUID_B,
      version: 1,
      framing: "You are a **Worker**.",
      system_prompt: "You are a worker.",
      skills: [{ name: "status", body: "Use clobber status." }],
      allowed_tools: ["Bash"],
      hooks: {},
      triggers: [],
      seed_refs: [{ name: "repo-sdlc", enabled: true }],
      created_at: 1700000000000,
    },
    version_history: [
      { id: UUID_B, version: 1, created_at: 1700000000000 },
    ],
  } as const;

  it("accepts a full detail payload", () => {
    const result = RoleDetailResponseSchema.safeParse(baseDetail);
    expect(result.success).toBe(true);
  });

  it("accepts a trigger entry inside current_version.triggers", () => {
    const result = RoleDetailResponseSchema.safeParse({
      ...baseDetail,
      current_version: {
        ...baseDetail.current_version,
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a detail payload missing current_version", () => {
    const { current_version: _omit, ...rest } = baseDetail;
    const result = RoleDetailResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a skill missing body", () => {
    const result = RoleDetailResponseSchema.safeParse({
      ...baseDetail,
      current_version: {
        ...baseDetail.current_version,
        skills: [{ name: "broken" }],
      },
    });
    expect(result.success).toBe(false);
  });
});
