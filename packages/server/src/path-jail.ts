import type { PathJail, PreToolUsePayload } from "@clobber/shared";
import {
  isWithin,
  resolveToolPath,
  hasWriteIntent,
  extractBashWriteTargets,
} from "./tool-write-targets.ts";

// #398-D1 — evaluator for the `refuse` action's path-jail predicate.
// Write-target extraction delegates to tool-write-targets.ts (shared with
// office-boundary-guard). See that module for the best-effort contract on
// Bash command parsing.
export function isPathJailed(predicate: PathJail, payload: PreToolUsePayload): boolean {
  const targets = writeTargets(payload);
  return targets.some((t) => isTargetJailed(predicate, t));
}

function isTargetJailed(predicate: PathJail, target: string): boolean {
  if (predicate.under !== undefined && isWithin(target, predicate.under)) return false;
  if (predicate.except !== undefined && isWithin(target, predicate.except)) return false;
  return isWithin(target, predicate.outside);
}

function writeTargets(payload: PreToolUsePayload): string[] {
  const input = payload.tool_input;

  if (
    payload.tool_name === "Write" ||
    payload.tool_name === "Edit" ||
    payload.tool_name === "MultiEdit"
  ) {
    const fp = stringField(input, "file_path");
    return fp === null ? [] : [resolveToolPath(fp, payload.cwd)];
  }

  if (payload.tool_name === "Bash") {
    const command = stringField(input, "command");
    if (command === null || !hasWriteIntent(command)) return [];
    return extractBashWriteTargets(command, payload.cwd);
  }

  return [];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
