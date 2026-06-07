// Track C Step 3 (#560) — single-tier scope algebra.
// Track C Step 4 (#565) — workspace perms tier: CliScopeSchema + DEFAULT_WORKSPACE_PERMS_SCOPE.

import { z } from "zod";
import {
  allCapabilityNames,
  capabilityNamesByTag,
  type CliCapabilityTag,
} from "./cli-capabilities.ts";

export interface CliScope {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

// Zod shape for storage and route validation. Token semantics (unknown verbs,
// deny prefix) are validated at runtime by isActionAllowed/expandDenyToken (Rule 3).
export const CliScopeSchema = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
});

// Permissive default — grants every capability, denies nothing.
// Used as the column DEFAULT so pre-existing workspace rows are unaffected.
export const DEFAULT_WORKSPACE_PERMS_SCOPE: CliScope = { allow: ["*"], deny: [] };

const VALID_TAGS = new Set<string>(["read", "write", "admin"]);

// Expands one token (stripped of any leading '!') to the verb names it covers.
// onUnknownVerb controls what happens for an exact-verb token not in the registry:
//   "empty" — return the empty set (shim compat; unknown allow tokens grant nothing)
//   "throw" — throw (deny typos are always config errors, Rule 3)
function expandToken(
  token: string,
  onUnknownVerb: "empty" | "throw",
  rawForError: string,
): Set<string> {
  if (token === "*") {
    return new Set(allCapabilityNames());
  }

  if (token.startsWith("tag:")) {
    const tag = token.slice(4);
    if (!VALID_TAGS.has(tag)) {
      throw new Error(`unknown tag in token '${rawForError}': '${tag}'`);
    }
    return new Set(capabilityNamesByTag(tag as CliCapabilityTag));
  }

  if (token.endsWith(".*")) {
    const prefix = token.slice(0, -2);
    return new Set(allCapabilityNames().filter((n) => n.startsWith(prefix + ".")));
  }

  // Exact verb.
  if (allCapabilityNames().includes(token)) {
    return new Set([token]);
  }
  if (onUnknownVerb === "throw") {
    throw new Error(`unknown verb in deny token '${rawForError}'`);
  }
  return new Set<string>();
}

function expandAllowToken(token: string): Set<string> {
  return expandToken(token, "empty", token);
}

function expandDenyToken(raw: string): Set<string> {
  if (!raw.startsWith("!")) {
    throw new Error(`deny token must start with '!': '${raw}'`);
  }
  if (raw === "!*") {
    throw new Error(`'!*' is not a valid deny token — NO deny-all`);
  }
  return expandToken(raw.slice(1), "throw", raw);
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
