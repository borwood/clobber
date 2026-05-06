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
