import type { BootContext, BootContextProvider } from "@clobber/shared";

// Runs a workspace's configured boot-context provider and returns the text
// to inject at spawn. The inbound mirror of final-report-consumer's callback
// runner (runExec / runHttp), pointed the opposite direction: instead of
// firing a payload out, it pulls text in.
//
// Failure semantics (CLAUDE.md Engineering Rule 3 — no defensive programming):
// a configured (non-noop) provider that exits non-zero (exec) or returns
// non-2xx (http) is unexpected data → throw. Resilience is the provider
// script's responsibility, not the engine's. `noop` is the only do-nothing.
// Reused by SessionStart resume injection (#66) once that handler lands.
export async function runBootContextProvider(
  provider: BootContextProvider,
  context: BootContext,
): Promise<string> {
  if (provider.kind === "noop") return "";
  if (provider.kind === "exec") {
    return runExec(provider.command, provider.args ?? [], context);
  }
  return runHttp(provider.url, provider.headers ?? {}, context);
}

async function runExec(
  command: string,
  args: readonly string[],
  context: BootContext,
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(context));
  await proc.stdin.end();
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `boot-context exec provider exited ${code}: ${stderr.trim().slice(0, 500)}`,
    );
  }
  return stdout;
}

async function runHttp(
  url: string,
  headers: Record<string, string>,
  context: BootContext,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(context),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `boot-context http provider responded ${res.status}: ${body.trim().slice(0, 500)}`,
    );
  }
  return res.text();
}
