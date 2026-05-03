import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ValidatePathResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function validateWorkspacePath(repoPath: string): ValidatePathResult {
  if (repoPath.length === 0) {
    return { ok: false, error: "repo_path is empty" };
  }
  if (!isAbsolute(repoPath)) {
    return { ok: false, error: "repo_path must be an absolute path" };
  }
  if (!existsSync(repoPath)) {
    return { ok: false, error: "repo_path does not exist" };
  }
  if (!statSync(repoPath).isDirectory()) {
    return { ok: false, error: "repo_path is not a directory" };
  }
  if (!existsSync(join(repoPath, ".git"))) {
    return { ok: false, error: "repo_path is not a git repository" };
  }
  return { ok: true };
}
