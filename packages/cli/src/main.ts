import { CommandRegistry, type Command } from "./commands.ts";
import { whoamiCommand } from "./commands/whoami.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { agentsCommand } from "./commands/agents.ts";
import { killCommand } from "./commands/kill.ts";
import { resumeCommand } from "./commands/resume.ts";
import { cycleCommand } from "./commands/cycle.ts";
import { transcriptCommand } from "./commands/transcript.ts";
import { statusCommand } from "./commands/status.ts";
import { reportCommand } from "./commands/report.ts";
import { reportsCommand } from "./commands/reports.ts";
import { askCommand } from "./commands/ask.ts";
import { messageCommand } from "./commands/message.ts";
import { replyCommand } from "./commands/reply.ts";
import { rolesCommand } from "./commands/roles.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { selfSkillsCommand } from "./commands/self-skills.ts";
import { dbDryRunCommand } from "./commands/db-dryrun.ts";
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
  registry.register(resumeCommand);
  registry.register(cycleCommand);
  registry.register(transcriptCommand);
  registry.register(statusCommand);
  registry.register(reportCommand);
  registry.register(reportsCommand);
  registry.register(askCommand);
  registry.register(messageCommand);
  registry.register(replyCommand);
  registry.register(rolesCommand);
  registry.register(workspaceCommand);
  registry.register(selfSkillsCommand);
  registry.register(dbDryRunCommand);
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

  const bareSubcommandVerb =
    rest.length === 0 && command.subcommands !== undefined;
  if (rest.some(isHelpFlag) || bareSubcommandVerb) {
    printCommandHelp(command, opts.stdout);
    return 0;
  }

  // Server commands resolve the agent env eagerly so a missing token fails fast
  // (and, for direct-arg verbs, before any command logic runs). Local dev
  // commands never reach the server, so they skip it; the getter throws loudly
  // if such a command mistakenly reads `ctx.env`.
  const env = command.local === true ? null : readEnv(opts.env);
  try {
    return await command.run({
      get env() {
        if (env === null) {
          throw new CliUsageError(
            `${command.name} is a local command and does not use the agent API`,
          );
        }
        return env;
      },
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
