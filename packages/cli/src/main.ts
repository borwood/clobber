import { CommandRegistry } from "./commands.ts";
import { whoamiCommand } from "./commands/whoami.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { agentsCommand } from "./commands/agents.ts";
import { readEnv, CliEnvError } from "./env.ts";
import { CliHttpError } from "./http.ts";
import { CliUsageError } from "./usage-error.ts";

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(whoamiCommand);
  registry.register(spawnCommand);
  registry.register(agentsCommand);
  return registry;
}

function printUsage(registry: CommandRegistry, stdout: NodeJS.WritableStream): void {
  stdout.write("usage: clobber <command> [args...]\n\ncommands:\n");
  for (const cmd of registry.list()) {
    stdout.write(`  ${cmd.name.padEnd(12)} ${cmd.summary}\n`);
  }
}

export async function run(opts: RunOptions): Promise<number> {
  const registry = buildRegistry();
  const [name, ...rest] = opts.argv;

  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    printUsage(registry, opts.stdout);
    return 0;
  }

  const command = registry.get(name);
  if (command === null) {
    opts.stderr.write(`unknown command: ${name}\n\n`);
    printUsage(registry, opts.stderr);
    return 2;
  }

  const env = readEnv(opts.env);
  try {
    return await command.run({
      env,
      args: rest,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
  } catch (err) {
    if (err instanceof CliUsageError) {
      opts.stderr.write(`${err.message}\n\n`);
      printUsage(registry, opts.stderr);
      return 2;
    }
    throw err;
  }
}

export async function runWithExit(opts: RunOptions): Promise<number> {
  try {
    return await run(opts);
  } catch (err) {
    if (err instanceof CliEnvError) {
      opts.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof CliUsageError) {
      opts.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof CliHttpError) {
      opts.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
