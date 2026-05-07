import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code writes session transcripts to
// `~/.claude/projects/<slug>/<sessionId>.jsonl`, where <slug> is the cwd with
// every non-`[A-Za-z0-9-]` byte replaced by `-` (so `/`, `.`, `_` all collapse).
// Empirically confirmed against on-disk projects on 2026-05-06.
export function deriveTranscriptPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9-]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}
