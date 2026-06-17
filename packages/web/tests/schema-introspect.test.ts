import { describe, it, expect } from "bun:test";
import { UpdateWorkspaceConfigRequestSchema } from "@clobber/shared";
import { describeSchema, type FieldNode } from "../src/lib/schema-introspect.ts";

const root = describeSchema(UpdateWorkspaceConfigRequestSchema);

function field(node: FieldNode, key: string) {
  if (node.kind !== "object") throw new Error("not an object node");
  const f = node.fields.find((x) => x.key === key);
  if (f === undefined) throw new Error(`no field ${key}`);
  return f;
}

describe("describeSchema — UpdateWorkspaceConfigRequestSchema", () => {
  it("yields an object node carrying every patchable field", () => {
    expect(root.kind).toBe("object");
    if (root.kind !== "object") return;
    expect(root.fields.map((f) => f.key).sort()).toEqual(
      [
        "file_size_policy",
        "final_report_callback",
        "manager_skill_policy",
        "perms_scope",
        "role_edit_policy",
        "setting_sources",
        "spawn_worktree",
        "theme",
        "trigger_overrides",
      ].sort(),
    );
  });

  it("maps an array-of-enum to array-enum with options", () => {
    const f = field(root, "setting_sources");
    expect(f.node).toEqual({
      kind: "array-enum",
      options: ["user", "project", "local"],
    });
  });

  it("recurses objects: manager_skill_policy → boolean + array-string", () => {
    const f = field(root, "manager_skill_policy");
    expect(f.node.kind).toBe("object");
    if (f.node.kind !== "object") return;
    expect(field(f.node, "allow_self_grant").node.kind).toBe("boolean");
    expect(field(f.node, "allowed_skills").node.kind).toBe("array-string");
  });

  it("maps a discriminated union to variants keyed by their kind literal", () => {
    const f = field(root, "spawn_worktree");
    expect(f.node.kind).toBe("union");
    if (f.node.kind !== "union") return;
    expect(f.node.discriminator).toBe("kind");
    const tags = f.node.variants.map((v) => v.tag).sort();
    expect(tags).toEqual(["off", "on"]);
    const off = f.node.variants.find((v) => v.tag === "off")!;
    expect(off.fields).toEqual([]);
    const on = f.node.variants.find((v) => v.tag === "on")!;
    expect(on.fields.map((x) => x.key).sort()).toEqual(
      ["branch_prefix", "install_timeout_ms", "worktree_root"].sort(),
    );
    expect(field({ kind: "object", fields: on.fields }, "install_timeout_ms").node.kind).toBe("number");
  });

  it("maps a string-keyed string-value record to string-record, object-value record to raw", () => {
    const http = field(root, "final_report_callback");
    if (http.node.kind !== "union") throw new Error("expected union");
    const httpVariant = http.node.variants.find((v) => v.tag === "http")!;
    expect(field({ kind: "object", fields: httpVariant.fields }, "headers").node.kind).toBe("string-record");

    // trigger_overrides is record<uuid, object> — irreducible → raw
    expect(field(root, "trigger_overrides").node.kind).toBe("raw");
  });

  it("treats non-discriminated unions (theme.mode, theme.accent) as raw, sibling enum intact", () => {
    const theme = field(root, "theme");
    if (theme.node.kind !== "object") throw new Error("expected object");
    expect(field(theme.node, "mode").node.kind).toBe("raw");
    // accent widened to union(built-in | custom-color) → non-discriminated → raw
    expect(field(theme.node, "accent").node.kind).toBe("raw");
    expect(field(theme.node, "pfpSize").node.kind).toBe("enum");
  });

  it("reads .meta() copy declared on the schema", () => {
    expect(field(root, "setting_sources").meta.title).toBeDefined();
  });
});
