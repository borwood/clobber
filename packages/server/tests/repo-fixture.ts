import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RepoFixture {
  readonly path: string;
  readonly cleanup: () => void;
}

export function makeRepoFixture(prefix = "clobber-repo-"): RepoFixture {
  const path = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(path, ".git"), "gitdir: stub\n");
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
