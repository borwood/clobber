/**
 * Spike #2: blocking/synchronous hooks.
 *
 * The "agent asks user a question" UX needs claude to *wait* on our HTTP
 * receiver until the user answers. Verify two things:
 *
 *   A. With `async: false`, claude actually waits for our response (proven by
 *      timing: claude's wall time grows by our deliberate delay).
 *   B. Returning `{ "decision": "block", "reason": "..." }` from a PreToolUse
 *      hook actually prevents the tool from running.
 *
 * Uses Bun.serve() to avoid pulling fastify into the script's resolution path.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = 3301;
const BASE = `http://127.0.0.1:${PORT}`;

interface HookCall {
  path: string;
  receivedAt: number;
  respondedAt: number;
  payload: Record<string, unknown>;
}

const calls: HookCall[] = [];

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const payload = (await req.json()) as Record<string, unknown>;
    const receivedAt = Date.now();

    if (path === "/hook/allow-after-3s") {
      await Bun.sleep(3000);
      const respondedAt = Date.now();
      calls.push({ path, receivedAt, respondedAt, payload });
      return Response.json({});
    }

    if (path === "/hook/block") {
      const respondedAt = Date.now();
      calls.push({ path, receivedAt, respondedAt, payload });
      return Response.json({ decision: "block", reason: "blocked by spike2" });
    }

    if (path === "/hook/log") {
      const respondedAt = Date.now();
      calls.push({ path, receivedAt, respondedAt, payload });
      return Response.json({});
    }

    return new Response("not found", { status: 404 });
  },
});
console.log(`[spike2] receiver on ${BASE}`);

async function runScenario(name: string, preToolHookUrl: string, prompt: string) {
  console.log(`\n========================================`);
  console.log(`SCENARIO: ${name}`);
  console.log(`  PreToolUse → ${preToolHookUrl} (sync, async:false)`);
  console.log(`========================================`);

  calls.length = 0;

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [{ type: "http", url: preToolHookUrl, async: false, timeout: 60 }],
        },
      ],
      PostToolUse: [
        { matcher: ".*", hooks: [{ type: "http", url: `${BASE}/hook/log`, async: true }] },
      ],
      Stop:       [{ hooks: [{ type: "http", url: `${BASE}/hook/log`, async: true }] }],
      SessionEnd: [{ hooks: [{ type: "http", url: `${BASE}/hook/log`, async: true }] }],
    },
  };

  const workDir = await mkdtemp(join(tmpdir(), "clobber-spike2-"));
  const sessionId = randomUUID();

  const args = [
    "--session-id", sessionId,
    "--settings", JSON.stringify(settings),
    "--setting-sources", "user",
    "--allowedTools", "Bash",
    "--permission-mode", "bypassPermissions",
    "-p",
    "--output-format", "stream-json",
    "--include-hook-events",
    "--verbose",
    prompt,
  ];

  const t0 = Date.now();
  const child = spawn("claude", args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });

  const stdoutChunks: string[] = [];
  child.stdout.on("data", (d) => stdoutChunks.push(d.toString()));
  const stderrChunks: string[] = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code))
  );
  const elapsed = Date.now() - t0;
  console.log(`exit=${exitCode} elapsed=${elapsed}ms`);

  console.log(`HTTP calls received: ${calls.length}`);
  for (const c of calls) {
    const event = c.payload["hook_event_name"];
    const tool = c.payload["tool_name"] ?? "";
    const wait = c.respondedAt - c.receivedAt;
    console.log(`  ${c.path}  event=${event} ${tool}  (we held for ${wait}ms before responding)`);
  }

  const stream: Record<string, unknown>[] = [];
  for (const line of stdoutChunks.join("").split("\n")) {
    if (!line.trim()) continue;
    try {
      stream.push(JSON.parse(line));
    } catch {
      // skip
    }
  }

  const preHookResponses = stream.filter(
    (e) => e["type"] === "system" && e["subtype"] === "hook_response" && e["hook_event"] === "PreToolUse",
  );
  console.log(`PreToolUse hook_response records in stream: ${preHookResponses.length}`);
  for (const r of preHookResponses) {
    console.log(`  outcome=${r["outcome"]} exit_code=${r["exit_code"]} stdout=${String(r["stdout"]).slice(0, 200)}`);
  }

  const toolResults = stream.filter((e) => {
    if (e["type"] !== "user") return false;
    const message = e["message"] as { content?: Array<{ type?: string }> } | undefined;
    return message?.content?.some((c) => c.type === "tool_result") ?? false;
  });
  console.log(`tool_result messages in stream: ${toolResults.length}`);

  const result = stream.find((e) => e["type"] === "result");
  if (result) {
    console.log(`final result: subtype=${result["subtype"]} num_turns=${result["num_turns"]}`);
    const txt = String(result["result"] ?? "").slice(0, 200);
    if (txt) console.log(`  result.text: ${txt}`);
  }

  if (stderrChunks.length > 0) {
    const err = stderrChunks.join("").trim();
    if (err) console.log(`stderr (first 500): ${err.slice(0, 500)}`);
  }
}

await runScenario(
  "A: PreToolUse blocking, delay 3s, then allow (return {})",
  `${BASE}/hook/allow-after-3s`,
  "Use the Bash tool to run `echo hello-from-spike-2` and then say 'done'.",
);

await runScenario(
  'B: PreToolUse blocking, return {"decision":"block"}',
  `${BASE}/hook/block`,
  // Identical phrasing to A; only the hook URL differs. Prevents claude's
  // prompt-injection heuristic from being the variable that changes outcomes.
  "Use the Bash tool to run `echo hello-from-spike-2` and then say 'done'.",
);

server.stop();
console.log("\n[spike2] done.");
process.exit(0);
