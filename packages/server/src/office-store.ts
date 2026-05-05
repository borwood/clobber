import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function officePathFor(repoPath: string, agentId: string): string {
  return join(repoPath, ".clobber", "offices", agentId);
}

export function ensureOffice(repoPath: string, agentId: string): string {
  const path = officePathFor(repoPath, agentId);
  mkdirSync(path, { recursive: true });
  return path;
}

export function removeOffice(repoPath: string, agentId: string): void {
  rmSync(officePathFor(repoPath, agentId), { recursive: true, force: true });
}
