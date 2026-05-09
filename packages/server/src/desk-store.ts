import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BriefingFile } from "@clobber/shared";

// Resolves the desk directory for an agent, anchored at the workspace's
// repo root: `<repo>/.clobber/agents/<agent_id>/desk/`. Pure path math; does
// not touch the filesystem.
export function deskDirFor(repoPath: string, agentId: string): string {
  return join(repoPath, ".clobber", "agents", agentId, "desk");
}

// Writes a briefing packet of files to the agent's desk. Validates each
// file path against the desk root before writing — defence in depth on top
// of the schema-level filename refinement on `BriefingFile`.
export function writeBriefingPacket(
  deskDir: string,
  files: readonly BriefingFile[],
): void {
  if (files.length === 0) return;
  mkdirSync(deskDir, { recursive: true });
  const deskRoot = resolve(deskDir);
  for (const file of files) {
    const absolute = resolve(deskDir, file.name);
    if (
      absolute !== deskRoot &&
      !absolute.startsWith(`${deskRoot}/`) &&
      !absolute.startsWith(`${deskRoot}\\`)
    ) {
      throw new Error(
        `briefing file '${file.name}' would escape the desk directory`,
      );
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf8");
  }
}
