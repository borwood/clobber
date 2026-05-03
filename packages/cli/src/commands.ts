import type { CliEnv } from "./env.ts";

export interface CommandContext {
  readonly env: CliEnv;
  readonly args: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
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
