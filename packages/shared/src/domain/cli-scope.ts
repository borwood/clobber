// Track C Step 3 (#560) — single-tier scope algebra.
// Multi-tier resolution (intersection across workspace/role/agent tiers) is Step 4/5.

import {
  CLI_CAPABILITY_REGISTRY,
  type CliCapabilityTag,
} from "./cli-capabilities.ts";

export interface CliScope {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

const VALID_TAGS = new Set<string>(["read", "write", "admin"]);

// Expands one allow token to the set of verb names it grants.
// Unknown bare verbs (not *, not tag:, not <prefix>.*, not in registry) → empty
// set so the shim stays byte-identical with the old includes() semantics.
function expandAllowToken(token: string): Set<string> {
  if (token === "*") {
    return new Set(Object.keys(CLI_CAPABILITY_REGISTRY));
  }

  if (token.startsWith("tag:")) {
    const tag = token.slice(4);
    if (!VALID_TAGS.has(tag)) {
      throw new Error(`unknown tag in allow token '${token}': '${tag}'`);
    }
    return new Set(
      Object.values(CLI_CAPABILITY_REGISTRY)
        .filter((c) => c.tag === (tag as CliCapabilityTag))
        .map((c) => c.name),
    );
  }

  if (token.endsWith(".*")) {
    const prefix = token.slice(0, -2);
    return new Set(
      Object.keys(CLI_CAPABILITY_REGISTRY).filter((n) =>
        n.startsWith(prefix + "."),
      ),
    );
  }

  // Exact verb: known → singleton; unknown → empty (shim compat; see PR note).
  if (CLI_CAPABILITY_REGISTRY[token] !== undefined) {
    return new Set([token]);
  }
  return new Set<string>();
}

// Expands one deny token (must start with '!') to the set of verbs it denies.
// Rule 3: malformed or unknown deny tokens throw — deny typos are always config errors.
function expandDenyToken(raw: string): Set<string> {
  if (!raw.startsWith("!")) {
    throw new Error(`deny token must start with '!': '${raw}'`);
  }
  if (raw === "!*") {
    throw new Error(`'!*' is not a valid deny token — NO deny-all`);
  }

  const token = raw.slice(1);

  if (token.startsWith("tag:")) {
    const tag = token.slice(4);
    if (!VALID_TAGS.has(tag)) {
      throw new Error(`unknown tag in deny token '${raw}': '${tag}'`);
    }
    return new Set(
      Object.values(CLI_CAPABILITY_REGISTRY)
        .filter((c) => c.tag === (tag as CliCapabilityTag))
        .map((c) => c.name),
    );
  }

  if (token.endsWith(".*")) {
    const prefix = token.slice(0, -2);
    return new Set(
      Object.keys(CLI_CAPABILITY_REGISTRY).filter((n) =>
        n.startsWith(prefix + "."),
      ),
    );
  }

  // Exact verb — unknown → throw (deny typos are always errors).
  if (CLI_CAPABILITY_REGISTRY[token] !== undefined) {
    return new Set([token]);
  }
  throw new Error(`unknown verb in deny token '${raw}'`);
}

// Single-tier: allow = union of expanded allow tokens; deny = union of expanded deny tokens.
// effective = allow \ deny; isActionAllowed = action ∈ effective.
export function isActionAllowed(scope: CliScope, action: string): boolean {
  const allowSet = new Set<string>();
  for (const token of scope.allow) {
    for (const verb of expandAllowToken(token)) allowSet.add(verb);
  }

  const denySet = new Set<string>();
  for (const token of scope.deny) {
    for (const verb of expandDenyToken(token)) denySet.add(verb);
  }

  return allowSet.has(action) && !denySet.has(action);
}
