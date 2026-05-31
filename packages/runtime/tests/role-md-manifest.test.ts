import { describe, it, expect } from "bun:test";
import {
  parseRoleManifest,
  renderRoleManifest,
  type RoleEditManifest,
} from "@clobber/shared";
import { roleEditSpecBody } from "../src/role-md.ts";

// #216 — the `ROLE.md` sidecar codec. The checkout root carries YAML-ish
// frontmatter (the role's canonical metadata) + an engine-generated edit-spec
// body. Only the frontmatter round-trips through a commit; the body is
// regenerated at checkout (Q1). This proves the frontmatter parse/render is
// lossless and rejects malformed metadata fail-fast (no defensive coercion).

describe("ROLE.md manifest codec (#216)", () => {
  const manifest: RoleEditManifest = {
    name: "repro-worker",
    description: "A worker tuned for bisect-and-reproduce tasks.",
    persistent: false,
    effort: "high",
  };

  it("round-trips frontmatter through render → parse", () => {
    const rendered = renderRoleManifest(manifest, roleEditSpecBody("repro-worker"));
    expect(parseRoleManifest(rendered)).toEqual(manifest);
  });

  it("ignores the body — only the frontmatter is canonical", () => {
    const a = renderRoleManifest(manifest, "# one body\n");
    const b = renderRoleManifest(manifest, "# a totally different body\n");
    expect(parseRoleManifest(a)).toEqual(parseRoleManifest(b));
  });

  it("rejects a non-slug name (ROLE_NAME_RE)", () => {
    const bad = renderRoleManifest(manifest, "body").replace(
      "repro-worker",
      "bad name",
    );
    expect(() => parseRoleManifest(bad)).toThrow();
  });

  it("rejects an effort outside the engine enum", () => {
    const bad = renderRoleManifest(manifest, "body").replace(
      "effort: high",
      "effort: ultra",
    );
    expect(() => parseRoleManifest(bad)).toThrow();
  });

  it("rejects a file with no frontmatter fence", () => {
    expect(() => parseRoleManifest("# just a body, no frontmatter\n")).toThrow();
  });
});
