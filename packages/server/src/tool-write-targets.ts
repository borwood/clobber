import { relative, resolve, sep } from "node:path";

// Shared primitives for extracting write targets from PreToolUse hook payloads.
// Consumed by office-boundary-guard (office-root containment) and path-jail
// (refuse-habit predicate evaluation). Keeping the logic in one place prevents
// the two guards from diverging on their Bash write-detection heuristics.
//
// BEST-EFFORT CONTRACT: This module parses command strings to infer which paths
// a Bash invocation will write to. It covers the common cases — redirect
// operators (>, >>), tee, cp, mv, install, rsync, and sed -i — but it CANNOT
// catch interpreter-mediated writes: `python3 -c "open(...).write(...)"`, `perl
// -e 'print ...'`, shell heredoc redirections into subshells, etc. The durable
// fix for those is an FS-level boundary (e.g., a container or seccomp filter);
// this module is best-effort static analysis for the common scripting patterns.

export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep));
}

export function resolveToolPath(path: string, cwd: string): string {
  return path.startsWith("/") ? resolve(path) : resolve(cwd, path);
}

export function hasWriteIntent(command: string): boolean {
  return /(^|[\s;&|])(?:>|>>)/.test(command) ||
    /(^|[\s;&|])\S+>{1,2}/.test(command) ||
    /(^|[\s;&|])(?:tee|cp|mv|install|touch|mkdir|rm|rsync|sed)\b/.test(command);
}

export function shellTokens(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const token = m[1] ?? m[2] ?? m[3];
    if (token !== undefined && token.length > 0) out.push(token);
  }
  return out;
}

// Returns all resolved absolute write-target paths inferred from a Bash command.
// Best-effort — see module comment for the residual gap.
export function extractBashWriteTargets(command: string, cwd: string): string[] {
  const targets = new Set<string>();
  const tokens = shellTokens(command);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    // Redirect operators: `> file`, `>> file`
    if (token === ">" || token === ">>") {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        targets.add(resolveToolPath(next, cwd));
        i++;
      }
      continue;
    }

    // Redirect as single token: `>file`, `>>file`, `2>file`, `2>>file`
    if (/^\d?>{1,2}.+/.test(token)) {
      const path = token.replace(/^\d?>{1,2}/, "");
      if (path.length > 0) targets.add(resolveToolPath(path, cwd));
      continue;
    }

    // tee [-a] file  (takes the immediate non-flag argument)
    if (token === "tee") {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        targets.add(resolveToolPath(next, cwd));
      }
      continue;
    }

    // cp / mv / rsync — destination is the LAST positional argument.
    // Best-effort: flags with separate arguments (e.g. cp -t /dir src) may
    // misidentify the destination; the common `cp src dst` form is correct.
    if (token === "cp" || token === "mv" || token === "rsync") {
      const last = lastPositional(tokens, i + 1);
      if (last !== null) targets.add(resolveToolPath(last, cwd));
      continue;
    }

    // install [-m mode] [-o owner] [-g group] src dst — last positional.
    if (token === "install") {
      const last = lastPositional(tokens, i + 1);
      if (last !== null) targets.add(resolveToolPath(last, cwd));
      continue;
    }

    // sed -i[SUFFIX] 'script' file(s) — files come after the first non-flag token.
    // Recognises `-i`, `-i.bak`, `-ni`, etc. Only fires when -i is present.
    if (token === "sed") {
      const sedFiles = sedInplaceTargets(tokens, i + 1, cwd);
      for (const f of sedFiles) targets.add(f);
      continue;
    }
  }

  return [...targets];
}

function lastPositional(tokens: string[], start: number): string | null {
  let last: string | null = null;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) last = t;
  }
  return last;
}

function sedInplaceTargets(tokens: string[], start: number, cwd: string): string[] {
  const hasInPlace = tokens.slice(start).some((t) => /^-[a-zA-Z]*i/.test(t));
  if (!hasInPlace) return [];
  const targets: string[] = [];
  let scriptConsumed = false;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) continue;
    if (!scriptConsumed) { scriptConsumed = true; continue; } // skip expression
    targets.push(resolveToolPath(t, cwd));
  }
  return targets;
}
