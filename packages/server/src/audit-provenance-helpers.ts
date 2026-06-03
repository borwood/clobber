import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Resolve the last message uuid from a JSONL transcript file. Returns null if
// the file is absent, empty, or has no lines with a uuid field.
export function readLastMessageUuid(transcriptPath: string): string | null {
  if (!existsSync(transcriptPath)) return null;
  let lastUuid: string | null = null;
  const text = readFileSync(transcriptPath, "utf8");
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && "uuid" in parsed) {
        const uuid = (parsed as Record<string, unknown>).uuid;
        if (typeof uuid === "string") lastUuid = uuid;
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return lastUuid;
}

export interface GitProvenance {
  readonly commit: string;
  readonly branch: string;
}

// Run git rev-parse HEAD and git branch --show-current on repoPath.
// Best-effort: returns null on any failure (non-git dir, git not found, etc.).
// Brennan approved this defensive path — provenance metadata must never drop
// the audit row that carries it (#221).
export function resolveGitProvenance(repoPath: string): GitProvenance | null {
  try {
    const commitResult = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (commitResult.status !== 0) return null;
    const commit = commitResult.stdout.trim();

    const branchResult = spawnSync(
      "git",
      ["-C", repoPath, "branch", "--show-current"],
      { encoding: "utf8", timeout: 5000 },
    );
    const branch = branchResult.status === 0 ? branchResult.stdout.trim() : "";
    return { commit, branch };
  } catch {
    return null;
  }
}
