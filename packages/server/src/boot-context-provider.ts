import type { BootContext, BootContextProvider } from "@clobber/shared";

// Runs a {noop|exec|http} provider and returns the text it emits. Originally
// #166's workspace boot-context provider; now generalized as the dynamic-seed
// runner (#211) — the workspace-global field is retired, dynamic seeds are the
// only caller. `env` is merged into an exec provider's process environment so a
// dynamic seed script can read its spawn context ($CLOBBER_OFFICE_DIR, etc.);
// http providers receive the BootContext as the POST body instead.
//
// Failure semantics (CLAUDE.md Engineering Rule 3 — no defensive programming):
// a non-noop provider that exits non-zero (exec), times out, or returns non-2xx
// (http) is unexpected data → throw. Resilience is the script's job. `noop` is
// the only do-nothing.
//
// Runner audit (per #209/#211, do not inherit silently):
//   #157 — both arms now enforce PROVIDER_TIMEOUT_MS and throw on expiry.
//   #158 — the http error path reads res.text() without a swallowing .catch();
//          a body that won't read is itself an error and must surface.
export const PROVIDER_TIMEOUT_MS = 10_000;

export async function runBootContextProvider(
  provider: BootContextProvider,
  context: BootContext,
  env?: Record<string, string>,
): Promise<string> {
  if (provider.kind === "noop") return "";
  if (provider.kind === "exec") {
    return runExec(provider.command, provider.args ?? [], context, env);
  }
  return runHttp(provider.url, provider.headers ?? {}, context);
}

async function runExec(
  command: string,
  args: readonly string[],
  context: BootContext,
  env: Record<string, string> | undefined,
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  proc.stdin.write(JSON.stringify(context));
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PROVIDER_TIMEOUT_MS);

  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(
      `boot-context exec provider timed out after ${PROVIDER_TIMEOUT_MS}ms: ${command}`,
    );
  }
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
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `boot-context http provider responded ${res.status}: ${body.trim().slice(0, 500)}`,
    );
  }
  return res.text();
}
