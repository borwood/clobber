export interface CliEnv {
  readonly apiBase: string;
  readonly sessionToken: string;
}

export class CliEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliEnvError";
  }
}

export function readEnv(env: NodeJS.ProcessEnv): CliEnv {
  const apiBase = env["CLOBBER_API_BASE"];
  const sessionToken = env["CLOBBER_SESSION_TOKEN"];
  if (apiBase === undefined || apiBase.length === 0) {
    throw new CliEnvError(
      "CLOBBER_API_BASE is not set — this CLI must be invoked from inside a clobber-spawned agent.",
    );
  }
  if (sessionToken === undefined || sessionToken.length === 0) {
    throw new CliEnvError(
      "CLOBBER_SESSION_TOKEN is not set — this CLI must be invoked from inside a clobber-spawned agent.",
    );
  }
  return { apiBase: apiBase.replace(/\/$/, ""), sessionToken };
}
