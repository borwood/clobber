import type { CliEnv } from "./env.ts";

export class CliHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CliHttpError";
  }
}

interface RequestOptions {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
}

export async function request<T>(env: CliEnv, opts: RequestOptions): Promise<T> {
  const url = `${env.apiBase}${opts.path}`;
  const init: RequestInit = {
    method: opts.method,
    headers: {
      ...(env.sessionToken === undefined ? {} : { authorization: `Bearer ${env.sessionToken}` }),
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new CliHttpError(await failureMessage(res), res.status);
  }
  return (await res.json()) as T;
}

async function failureMessage(res: Response): Promise<string> {
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") === true;
  if (isJson) {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  }
  return `${res.status} ${text}`;
}
