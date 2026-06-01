import { readFileSync } from "node:fs";
import { CliUsageError } from "../usage-error.ts";

// Shared provider-flag parser for `prompt-modules create` and `prompt-modules edit`.
// Builds a PromptModuleDefinition from the CLI flags, ready to POST/PUT.

export type ProviderDefinition =
  | { kind: "static"; text: string }
  | { kind: "dynamic"; provider: ExecProvider | HttpProvider };

interface ExecProvider {
  kind: "exec";
  command: string;
  args?: string[];
}

interface HttpProvider {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
}

// When --static - is given, definition is deferred; caller must read stdin.
export type ParsedProviderFlags =
  | { readFromStdin: false; definition: ProviderDefinition; json: boolean }
  | { readFromStdin: true; json: boolean };

const PROVIDER_FLAGS_USAGE =
  "(--static-file FILE | --static - | --exec '<cmd>' [--exec-arg <arg>]... | --http <url> [--http-header k:v]...)";

export function parseProviderFlags(
  subcommand: string,
  args: readonly string[],
): ParsedProviderFlags {
  let definition: ProviderDefinition | undefined;
  let readFromStdin = false;
  let json = false;

  const execArgs: string[] = [];
  const httpHeaders: Record<string, string> = {};
  let execCommand: string | undefined;
  let httpUrl: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--static-file") {
      const path = args[i + 1];
      if (path === undefined || path.startsWith("-")) {
        throw new CliUsageError(`prompt-modules ${subcommand}: --static-file requires a file path`);
      }
      definition = { kind: "static", text: readFileSync(path, "utf8") };
      i += 1;
      continue;
    }

    if (arg === "--static") {
      const next = args[i + 1];
      if (next !== "-") {
        throw new CliUsageError(
          `prompt-modules ${subcommand}: --static requires '-' (stdin) — use --static-file for a path`,
        );
      }
      readFromStdin = true;
      i += 1;
      continue;
    }

    if (arg === "--exec") {
      const cmd = args[i + 1];
      if (cmd === undefined || cmd.startsWith("-")) {
        throw new CliUsageError(
          `prompt-modules ${subcommand}: --exec requires a shell command string`,
        );
      }
      execCommand = cmd;
      i += 1;
      continue;
    }

    if (arg === "--exec-arg") {
      const val = args[i + 1];
      if (val === undefined) {
        throw new CliUsageError(`prompt-modules ${subcommand}: --exec-arg requires a value`);
      }
      execArgs.push(val);
      i += 1;
      continue;
    }

    if (arg === "--http") {
      const url = args[i + 1];
      if (url === undefined || url.startsWith("-")) {
        throw new CliUsageError(`prompt-modules ${subcommand}: --http requires a URL`);
      }
      httpUrl = url;
      i += 1;
      continue;
    }

    if (arg === "--http-header") {
      const kv = args[i + 1];
      if (kv === undefined) {
        throw new CliUsageError(
          `prompt-modules ${subcommand}: --http-header requires a k:v pair`,
        );
      }
      const colon = kv.indexOf(":");
      if (colon === -1) {
        throw new CliUsageError(
          `prompt-modules ${subcommand}: --http-header must be 'key:value', got: ${kv}`,
        );
      }
      httpHeaders[kv.slice(0, colon)] = kv.slice(colon + 1);
      i += 1;
      continue;
    }

    throw new CliUsageError(`prompt-modules ${subcommand}: unknown argument: ${arg}`);
  }

  if (execCommand !== undefined) {
    if (definition !== undefined || readFromStdin) {
      throw new CliUsageError(
        `prompt-modules ${subcommand}: conflicting provider flags — use only one`,
      );
    }
    const provider: ExecProvider =
      execArgs.length > 0
        ? { kind: "exec", command: execCommand, args: execArgs }
        : { kind: "exec", command: execCommand };
    definition = { kind: "dynamic", provider };
  }

  if (httpUrl !== undefined) {
    if (definition !== undefined || readFromStdin) {
      throw new CliUsageError(
        `prompt-modules ${subcommand}: conflicting provider flags — use only one`,
      );
    }
    const provider: HttpProvider =
      Object.keys(httpHeaders).length > 0
        ? { kind: "http", url: httpUrl, headers: httpHeaders }
        : { kind: "http", url: httpUrl };
    definition = { kind: "dynamic", provider };
  }

  if (!readFromStdin && definition === undefined) {
    throw new CliUsageError(
      `prompt-modules ${subcommand}: missing provider flag ${PROVIDER_FLAGS_USAGE}`,
    );
  }

  if (readFromStdin) return { readFromStdin: true, json };
  return { readFromStdin: false, definition: definition!, json };
}

export async function readStdinText(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}
