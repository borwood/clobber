import type { CliEnv } from "./env.ts";

export interface Subcommand {
  readonly name: string;
  readonly capability?: string;
}

export interface CommandContext {
  readonly env: CliEnv;
  readonly args: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  /**
   * Declared when the verb dispatches on a subcommand (e.g. `roles list`).
   * Bare invocation of such a verb prints its help and exits 0 instead of
   * erroring — mirroring git/gh/kubectl discovery ergonomics.
   *
   * `capability` is the dotted name from the CLI capability registry for
   * server-hitting sub-verbs. Omitted for local-only sub-verbs and
   * sub-dispatchers that fan out to multiple capabilities.
   */
  readonly subcommands?: readonly Subcommand[];
  /**
   * Local dev commands operate on the filesystem (not the agent HTTP API) and
   * therefore do not require CLOBBER_API_BASE/SESSION_TOKEN. Server commands
   * (the default) resolve that env eagerly so a missing token fails fast.
   */
  readonly local?: boolean;
  run(ctx: CommandContext): Promise<number>;
}

export class CommandRegistry {
  private readonly byName = new Map<string, Command>();

  register(command: Command): void {
    this.byName.set(command.name, command);
  }

  get(name: string): Command | null {
    return this.byName.get(name) ?? null;
  }

  list(): readonly Command[] {
    return [...this.byName.values()];
  }
}
