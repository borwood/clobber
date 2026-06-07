import { relative, resolve, sep } from "node:path";
import type { PathJail, PreToolUsePayload } from "@clobber/shared";

// #398-D1 — evaluator for the `refuse` action's path-jail predicate.
// Extracts write targets from a PreToolUse payload (file_path for Edit/Write/MultiEdit,
// redirect targets for Bash) and checks each against the predicate.
export function isPathJailed(predicate: PathJail, payload: PreToolUsePayload): boolean {
  const targets = writeTargets(payload);
  return targets.some((t) => isTargetJailed(predicate, t));
}

function isTargetJailed(predicate: PathJail, target: string): boolean {
  if (predicate.under !== undefined && isWithin(target, predicate.under)) return false;
  if (predicate.except !== undefined && isWithin(target, predicate.except)) return false;
  return isWithin(target, predicate.outside);
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep));
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
    return extractRedirectTargets(command, payload.cwd);
  }

  return [];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function resolveToolPath(path: string, cwd: string): string {
  return path.startsWith("/") ? resolve(path) : resolve(cwd, path);
}

// Mirrors the write-intent check in office-boundary-guard.ts.
function hasWriteIntent(command: string): boolean {
  return /(^|[\s;&|])(?:>|>>)/.test(command) ||
    /(^|[\s;&|])\S+>{1,2}/.test(command) ||
    /(^|[\s;&|])(?:tee|cp|mv|install|touch|mkdir|rm|rsync)\b/.test(command);
}

// Extract redirect targets (`> path`, `>> path`, `tee path`) from a Bash command.
// Tokenises shell-ish syntax (quoted strings, redirection operators).
function extractRedirectTargets(command: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const raw = trimRedirectOperator(token);
    if (raw.length > 0 && isWriteOperator(token)) {
      candidates.add(resolveToolPath(raw, cwd));
      continue;
    }
    // `>` or `>>` as a standalone token — the next token is the target.
    if ((token === ">" || token === ">>") && i + 1 < tokens.length) {
      const next = tokens[i + 1]!;
      if (!next.startsWith("-")) {
        candidates.add(resolveToolPath(next, cwd));
      }
    }
    // `tee` — the next token is the file.
    if (token === "tee" && i + 1 < tokens.length) {
      const next = tokens[i + 1]!;
      if (!next.startsWith("-")) {
        candidates.add(resolveToolPath(next, cwd));
      }
    }
  }
  return [...candidates];
}

function isWriteOperator(token: string): boolean {
  return /^\d?>{1,2}.+/.test(token);
}

function trimRedirectOperator(token: string): string {
  return token.replace(/^\d?>{1,2}/, "");
}

function shellTokens(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const token = m[1] ?? m[2] ?? m[3];
    if (token !== undefined && token.length > 0) out.push(token);
  }
  return out;
}
