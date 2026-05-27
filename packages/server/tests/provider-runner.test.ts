import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { BootContext } from "@clobber/shared";
import { runBootContextProvider } from "../src/boot-context-provider.ts";

// The {noop|exec|http} provider runner reused as the dynamic-seed runner (#211,
// generalizing #166). These cover the generalization (env injection) and the
// runner-audit fixes carried in this issue: #157 (timeout enforced) and #158
// (the http error path reads the body without a swallowing .catch).
const context: BootContext = {
  workspace_id: "ws",
  agent_id: "ag",
  role_id: "ro",
  role_name: "worker",
  persistent: false,
};

describe("provider runner — exec", () => {
  it("returns stdout and exposes the injected env to the script", async () => {
    const out = await runBootContextProvider(
      { kind: "exec", command: "sh", args: ["-c", 'echo "ROLE=$CLOBBER_ROLE"'] },
      context,
      { CLOBBER_ROLE: "worker" },
    );
    expect(out.trim()).toBe("ROLE=worker");
  });

  it("passes the BootContext as JSON on stdin", async () => {
    const out = await runBootContextProvider(
      { kind: "exec", command: "sh", args: ["-c", "cat"] },
      context,
    );
    expect(JSON.parse(out).workspace_id).toBe("ws");
  });

  it("throws when the script exits non-zero (no soft-fail)", async () => {
    await expect(
      runBootContextProvider(
        { kind: "exec", command: "sh", args: ["-c", "echo boom >&2; exit 3"] },
        context,
      ),
    ).rejects.toThrow(/exited 3/);
  });

  it("noop returns the empty string", async () => {
    expect(await runBootContextProvider({ kind: "noop" }, context)).toBe("");
  });
});

describe("provider runner — http", () => {
  let server: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    server.post("/ok", async (req, reply) => {
      reply.header("content-type", "text/plain");
      return `seen:${(req.body as BootContext).role_name}`;
    });
    server.post("/bad", async (_req, reply) => {
      reply.code(500);
      return "upstream sad";
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("POSTs the context and returns the response body", async () => {
    const out = await runBootContextProvider({ kind: "http", url: `${base}/ok` }, context);
    expect(out).toBe("seen:worker");
  });

  it("throws on a non-2xx response, surfacing the body (#158)", async () => {
    await expect(
      runBootContextProvider({ kind: "http", url: `${base}/bad` }, context),
    ).rejects.toThrow(/responded 500: upstream sad/);
  });
});
