import { CommandRegistry, type Command } from "./commands.ts";
import { whoamiCommand } from "./commands/whoami.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { agentsCommand } from "./commands/agents.ts";
import { killCommand } from "./commands/kill.ts";
import { transcriptCommand } from "./commands/transcript.ts";
import { statusCommand } from "./commands/status.ts";
import { reportCommand } from "./commands/report.ts";
import { askCommand } from "./commands/ask.ts";
import { rolesCommand } from "./commands/roles.ts";
import { selfSkillsCommand } from "./commands/self-skills.ts";
import { readEnv, CliEnvError } from "./env.ts";
import { CliHttpError } from "./http.ts";
import { CliUsageError } from "./usage-error.ts";
import pkg from "../package.json" with { type: "json" };

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
}

function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(whoamiCommand);
  registry.register(spawnCommand);
  registry.register(agentsCommand);
  registry.register(killCommand);
  registry.register(transcriptCommand);
  registry.register(statusCommand);
  registry.register(reportCommand);
  registry.register(askCommand);
  registry.register(rolesCommand);
  registry.register(selfSkillsCommand);
  return registry;
}

function printUsage(registry: CommandRegistry, stdout: NodeJS.WritableStream): void {
  stdout.write("usage: clobber <command> [args...]\n\n");
  stdout.write("global flags:\n");
  stdout.write("  -V, --version   Print the clobber CLI version and exit.\n");
  stdout.write("  -h, --help      Print this usage. Use `clobber <verb> --help` for verb-specific help.\n\n");
  stdout.write("commands:\n");
  for (const cmd of registry.list()) {
    stdout.write(`  ${cmd.name.padEnd(12)} ${cmd.summary}\n`);
  }
}

function printCommandHelp(command: Command, stdout: NodeJS.WritableStream): void {
  if (command.usage !== undefined) {
    stdout.write(`${command.usage}\n`);
    return;
  }
  stdout.write(`usage: clobber ${command.name}\n\n${command.summary}\n`);
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

export async function run(opts: RunOptions): Promise<number> {
  const registry = buildRegistry();
  const [name, ...rest] = opts.argv;

  if (name === "--version" || name === "-V") {
    opts.stdout.write(`${pkg.version}\n`);
    return 0;
  }

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

  if (rest.some(isHelpFlag)) {
    printCommandHelp(command, opts.stdout);
    return 0;
  }

  const env = readEnv(opts.env);
  try {
    return await command.run({
      env,
      args: rest,
      stdout: opts.stdout,
      stderr: opts.stderr,
      stdin: opts.stdin ?? process.stdin,
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
