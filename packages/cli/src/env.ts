export interface CliEnv {
  readonly apiBase: string;
  readonly sessionToken: string;
  // Present when the CLI is running inside a clobber-spawned agent session.
  readonly agentId: string | undefined;
  // How long the ask command keeps retrying an unreachable server before it
  // declares the ask genuinely undeliverable and returns a trustable notice
  // (#241). A blocking ask never expires waiting for a human — this bounds only
  // the "can't reach the server at all" case.
  readonly askRetryBudgetMs: number;
  readonly askRetryIntervalMs: number;
}

export class CliEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliEnvError";
  }
}

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliEnvError(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
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
  const agentId = env["CLOBBER_AGENT_ID"];
  return {
    apiBase: apiBase.replace(/\/$/, ""),
    sessionToken,
    agentId: agentId !== undefined && agentId.length > 0 ? agentId : undefined,
    askRetryBudgetMs: readPositiveIntEnv(env, "CLOBBER_ASK_RETRY_BUDGET_MS", 60_000),
    askRetryIntervalMs: readPositiveIntEnv(env, "CLOBBER_ASK_RETRY_INTERVAL_MS", 1_000),
  };
}
