import { describe, it, expect } from "bun:test";
import { isActionAllowed } from "../src/domain/cli-scope.ts";

describe("isActionAllowed — allow token expansion", () => {
  it("exact known verb grants only that verb", () => {
    expect(isActionAllowed({ allow: ["roles.diff"], deny: [] }, "roles.diff")).toBe(true);
    expect(isActionAllowed({ allow: ["roles.diff"], deny: [] }, "roles.commit")).toBe(false);
  });

  it("prefix wildcard roles.* grants all roles sub-verbs", () => {
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.commit")).toBe(true);
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.diff")).toBe(true);
  });

  it("prefix wildcard roles.* is multi-level (grants roles.upstream.diff)", () => {
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.upstream.diff")).toBe(true);
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.upstream.log")).toBe(true);
  });

  it("narrow prefix roles.upstream.* grants only that sub-namespace", () => {
    expect(isActionAllowed({ allow: ["roles.upstream.*"], deny: [] }, "roles.upstream.diff")).toBe(true);
    expect(isActionAllowed({ allow: ["roles.upstream.*"], deny: [] }, "roles.upstream.log")).toBe(true);
    expect(isActionAllowed({ allow: ["roles.upstream.*"], deny: [] }, "roles.commit")).toBe(false);
    expect(isActionAllowed({ allow: ["roles.upstream.*"], deny: [] }, "roles.diff")).toBe(false);
  });

  it("* grants every registry verb including internal:true (fork ruling i)", () => {
    expect(isActionAllowed({ allow: ["*"], deny: [] }, "test-tool")).toBe(true);
    expect(isActionAllowed({ allow: ["*"], deny: [] }, "roles.commit")).toBe(true);
    expect(isActionAllowed({ allow: ["*"], deny: [] }, "agents")).toBe(true);
  });

  it("tag:read grants read-tagged verbs", () => {
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "agents")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "whoami")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "roles.diff")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "roles.commit")).toBe(false);
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "spawn")).toBe(false);
  });

  it("tag:write grants write-tagged verbs", () => {
    expect(isActionAllowed({ allow: ["tag:write"], deny: [] }, "ask")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:write"], deny: [] }, "status")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:write"], deny: [] }, "agents")).toBe(false);
    expect(isActionAllowed({ allow: ["tag:write"], deny: [] }, "spawn")).toBe(false);
  });

  it("tag:admin grants admin-tagged verbs", () => {
    expect(isActionAllowed({ allow: ["tag:admin"], deny: [] }, "spawn")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:admin"], deny: [] }, "roles.fetch")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:admin"], deny: [] }, "test-tool")).toBe(true);
    expect(isActionAllowed({ allow: ["tag:admin"], deny: [] }, "agents")).toBe(false);
  });

  it("tag:read excludes roles.fetch (admin-tagged; fork ruling ii)", () => {
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "roles.fetch")).toBe(false);
  });

  it("union within a tier: any matching token grants", () => {
    expect(isActionAllowed({ allow: ["agents", "whoami"], deny: [] }, "agents")).toBe(true);
    expect(isActionAllowed({ allow: ["agents", "whoami"], deny: [] }, "whoami")).toBe(true);
    expect(isActionAllowed({ allow: ["agents", "whoami"], deny: [] }, "spawn")).toBe(false);
  });
});

describe("isActionAllowed — deny token behavior", () => {
  it("!<verb> denies a specific verb even when wildcard grants it", () => {
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.commit"] }, "roles.commit")).toBe(false);
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.commit"] }, "roles.diff")).toBe(true);
  });

  it("!tag:admin denies all admin verbs", () => {
    expect(isActionAllowed({ allow: ["*"], deny: ["!tag:admin"] }, "spawn")).toBe(false);
    expect(isActionAllowed({ allow: ["*"], deny: ["!tag:admin"] }, "roles.fetch")).toBe(false);
    expect(isActionAllowed({ allow: ["*"], deny: ["!tag:admin"] }, "agents")).toBe(true);
  });

  it("!<prefix>.* denies a sub-namespace", () => {
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.*"] }, "roles.commit")).toBe(false);
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.*"] }, "roles.diff")).toBe(false);
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.*"] }, "agents")).toBe(true);
  });

  it("deny wins: effective = allow \\ deny", () => {
    expect(isActionAllowed({ allow: ["roles.*"], deny: ["!roles.fetch"] }, "roles.fetch")).toBe(false);
    expect(isActionAllowed({ allow: ["roles.*"], deny: ["!roles.fetch"] }, "roles.diff")).toBe(true);
  });

  it("empty allow + empty deny denies everything", () => {
    expect(isActionAllowed({ allow: [], deny: [] }, "agents")).toBe(false);
    expect(isActionAllowed({ allow: [], deny: [] }, "spawn")).toBe(false);
  });
});

describe("isActionAllowed — shim compatibility (bare/unknown tokens)", () => {
  it("unknown bare token in allow resolves to empty grant (not parse-reject)", () => {
    // 'roles' is not in the registry and is not a <prefix>.* token
    expect(isActionAllowed({ allow: ["roles"], deny: [] }, "roles.prompt-modules.add")).toBe(false);
    expect(isActionAllowed({ allow: ["roles"], deny: [] }, "roles.commit")).toBe(false);
  });

  it("'roles.prompt-modules' (no .*) resolves to empty grant", () => {
    expect(isActionAllowed({ allow: ["roles.prompt-modules"], deny: [] }, "roles.prompt-modules.add")).toBe(false);
  });
});

describe("isActionAllowed — Rule 3: malformed/unknown tokens throw", () => {
  it("!* in deny throws — no deny-all token", () => {
    expect(() => isActionAllowed({ allow: ["*"], deny: ["!*"] }, "agents")).toThrow();
  });

  it("deny token missing ! prefix throws", () => {
    expect(() => isActionAllowed({ allow: ["*"], deny: ["roles.commit"] }, "roles.commit")).toThrow();
  });

  it("unknown verb in deny throws", () => {
    expect(() => isActionAllowed({ allow: ["*"], deny: ["!not-a-real-verb"] }, "agents")).toThrow();
  });

  it("malformed tag in allow token throws", () => {
    expect(() => isActionAllowed({ allow: ["tag:superuser"], deny: [] }, "agents")).toThrow();
  });

  it("malformed tag in deny token throws", () => {
    expect(() => isActionAllowed({ allow: ["*"], deny: ["!tag:superuser"] }, "agents")).toThrow();
  });
});

describe("isActionAllowed — algebra test table from issue #560", () => {
  it("{allow:['roles']} → roles.commit : DENY", () => {
    expect(isActionAllowed({ allow: ["roles"], deny: [] }, "roles.commit")).toBe(false);
  });

  it("{allow:['roles.diff']} → roles.commit : DENY (sibling)", () => {
    expect(isActionAllowed({ allow: ["roles.diff"], deny: [] }, "roles.commit")).toBe(false);
  });

  it("{allow:['roles.*']} → roles.commit : ALLOW (explicit ns wildcard)", () => {
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.commit")).toBe(true);
  });

  it("{allow:['roles.*']} → roles.upstream.diff : ALLOW (multi-level prefix)", () => {
    expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, "roles.upstream.diff")).toBe(true);
  });

  it("{allow:['roles.upstream.*']} → roles.commit : DENY (deeper prefix doesn't grant shallower)", () => {
    expect(isActionAllowed({ allow: ["roles.upstream.*"], deny: [] }, "roles.commit")).toBe(false);
  });

  it("{allow:['*']} → test-tool : ALLOW (parity with today; * includes internal)", () => {
    expect(isActionAllowed({ allow: ["*"], deny: [] }, "test-tool")).toBe(true);
  });

  it("tag:read verbs ∩ roles.* verbs excludes roles.fetch (admin)", () => {
    // Verify tag:read does not include roles.fetch
    expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, "roles.fetch")).toBe(false);
    // Verify roles.* includes all expected read-tagged roles verbs
    const readRolesVerbs = ["roles.diff", "roles.list", "roles.show", "roles.status", "roles.upstream.diff", "roles.upstream.log"];
    for (const verb of readRolesVerbs) {
      expect(isActionAllowed({ allow: ["tag:read"], deny: [] }, verb)).toBe(true);
      expect(isActionAllowed({ allow: ["roles.*"], deny: [] }, verb)).toBe(true);
    }
  });

  it("deny: {allow:['*'], deny:['!roles.commit']} → roles.commit : DENY (deny wins over wildcard)", () => {
    expect(isActionAllowed({ allow: ["*"], deny: ["!roles.commit"] }, "roles.commit")).toBe(false);
  });
});
