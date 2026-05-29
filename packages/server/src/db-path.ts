import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ResolveDatabasePathInput {
  readonly envValue: string | undefined;
  readonly serverIndexUrl: string;
  readonly cwd: string;
}

const SQLITE_MEMORY = ":memory:";

export function resolveDatabasePath(input: ResolveDatabasePathInput): string {
  const { envValue, serverIndexUrl, cwd } = input;

  if (envValue !== undefined && envValue.length > 0) {
    if (envValue === SQLITE_MEMORY) return SQLITE_MEMORY;
    return isAbsolute(envValue) ? envValue : resolve(cwd, envValue);
  }

  const serverIndexDir = dirname(fileURLToPath(serverIndexUrl));
  const repoRoot = resolve(serverIndexDir, "../../..");
  return resolve(repoRoot, "clobber.db");
}

// Resolves the live database path the way the server boot does, but anchored on
// this module so callers outside the server (e.g. the `clobber` CLI) get the
// same `<repo-root>/clobber.db` default without knowing the server entrypoint's
// location. `db-path.ts` sits beside `index.ts`, so the `../../..` hop lands on
// the same repo root.
export function resolveDefaultDatabasePath(
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return resolveDatabasePath({
    envValue: env["CLOBBER_DB"],
    serverIndexUrl: import.meta.url,
    cwd,
  });
}
