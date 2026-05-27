import type { CliEnv } from "./env.ts";

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
   */
  readonly subcommands?: readonly string[];
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
