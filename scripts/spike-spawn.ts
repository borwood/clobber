/**
 * Spike: spawn one `claude` subprocess wired up so its hooks POST to a local
 * Fastify receiver. Captures hook events + stream-json output, prints findings.
 *
 * Goals: verify (a) `--session-id <uuid>` is honored end-to-end, (b) HTTP hooks
 * fire with the documented payload shape, (c) the session is persisted to disk
 * under our chosen UUID and is resumable.
 */
import { spawn } from "node:child_process";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "../packages/server/src/server.ts";
import { createDatabase } from "../packages/server/src/db.ts";
import { createEventStore } from "../packages/server/src/event-store.ts";
import { createWorkspaceStore } from "../packages/server/src/workspace-store.ts";

const PORT = 3300;
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;

const httpHook = { type: "http" as const, url: HOOK_URL, async: true };
const settings = {
  hooks: {
    SessionStart:     [{ hooks: [httpHook] }],
    SessionEnd:       [{ hooks: [httpHook] }],
    UserPromptSubmit: [{ hooks: [httpHook] }],
    PreToolUse:       [{ matcher: ".*", hooks: [httpHook] }],
    PostToolUse:      [{ matcher: ".*", hooks: [httpHook] }],
    Notification:     [{ hooks: [httpHook] }],
    Stop:             [{ hooks: [httpHook] }],
    PreCompact:       [{ hooks: [httpHook] }],
  },
};

const db = createDatabase(":memory:");
const store = createEventStore(db);
const workspaces = createWorkspaceStore(db);
const server = createServer({
  store,
  workspaces,
  spawner: () => ({ sessionId: "unused", pid: 0 }),
  hookUrl: HOOK_URL,
});
await server.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[spike] receiver listening on ${HOOK_URL}`);

const workDir = await mkdtemp(join(tmpdir(), "clobber-spike-"));
const sessionId = randomUUID();
console.log(`[spike] work dir:   ${workDir}`);
console.log(`[spike] session id: ${sessionId}`);

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
  "Run the bash command `echo hello-from-clobber-spike` and then say done.",
];

console.log(`[spike] spawning: claude ${args.slice(0, 4).join(" ")} ...`);
const t0 = Date.now();
const child = spawn("claude", args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });

const stdout: string[] = [];
const stderr: string[] = [];
child.stdout.on("data", (d) => stdout.push(d.toString()));
child.stderr.on("data", (d) => stderr.push(d.toString()));

const exitCode: number | null = await new Promise((resolve) => {
  child.on("exit", (code) => resolve(code));
});
const elapsed = Date.now() - t0;
console.log(`[spike] claude exited code=${exitCode} in ${elapsed}ms`);

const stdoutStr = stdout.join("");
const stderrStr = stderr.join("");

// Parse stream-json lines (each line = JSON object)
const streamLines = stdoutStr.split("\n").filter((l) => l.trim().length > 0);
const streamEvents: Array<Record<string, unknown>> = [];
for (const line of streamLines) {
  try {
    streamEvents.push(JSON.parse(line));
  } catch {
    streamEvents.push({ __unparseable: line });
  }
}

// Fetch HTTP-captured events
const httpEvents = (await (await fetch(`http://127.0.0.1:${PORT}/events`)).json()) as Array<
  Record<string, unknown>
>;

console.log("\n========================================");
console.log("HTTP HOOK EVENTS");
console.log("========================================");
console.log(`count: ${httpEvents.length}`);
for (const [i, ev] of httpEvents.entries()) {
  const name = ev["hook_event_name"];
  const sid = ev["session_id"];
  const tool = ev["tool_name"] ?? "";
  console.log(`  [${i}] ${name} session=${sid} ${tool}`);
}

console.log("\nFirst 3 HTTP events (full payloads):");
for (const ev of httpEvents.slice(0, 3)) {
  console.log(JSON.stringify(ev, null, 2));
  console.log("---");
}

console.log("\n========================================");
console.log("STREAM-JSON EVENTS (--include-hook-events)");
console.log("========================================");
console.log(`count: ${streamEvents.length}`);
const eventTypes = streamEvents.map((e) => {
  if (typeof e["event"] === "string") return `event:${e["event"]}`;
  if (typeof e["type"] === "string") return `type:${e["type"]}`;
  return "?";
});
const counts = eventTypes.reduce<Record<string, number>>((acc, k) => {
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);

console.log("\nFirst stream event of each type (compact):");
const seen = new Set<string>();
for (const e of streamEvents) {
  const key = (e["type"] as string) ?? (e["event"] as string) ?? "?";
  if (seen.has(key)) continue;
  seen.add(key);
  const compact = JSON.stringify(e).slice(0, 400);
  console.log(`  [${key}] ${compact}`);
}

console.log("\nAll system-event subtypes:");
for (const e of streamEvents) {
  if (e["type"] !== "system") continue;
  const sub = e["subtype"] ?? e["hook_event_name"] ?? "?";
  console.log(`  system.subtype=${sub} keys=${Object.keys(e).join(",")}`);
}

console.log("\n========================================");
console.log("SESSION ID VERIFICATION");
console.log("========================================");
console.log(`minted:           ${sessionId}`);
const httpSids = new Set(httpEvents.map((e) => e["session_id"]));
console.log(`hook session_ids: ${[...httpSids].join(", ")}`);
console.log(`match:            ${httpSids.size === 1 && httpSids.has(sessionId)}`);

console.log("\n========================================");
console.log("SESSION PERSISTENCE ON DISK");
console.log("========================================");
const projectsDir = join(homedir(), ".claude", "projects");
const cwdHash = createHash("md5").update(workDir).digest("hex");
let foundOnDisk = false;
let foundPath: string | undefined;
const projectDirs = await readdir(projectsDir, { withFileTypes: true });
for (const d of projectDirs) {
  if (!d.isDirectory()) continue;
  const sessionsDir = join(projectsDir, d.name, "sessions");
  try {
    const entries = await readdir(sessionsDir);
    const hit = entries.find((e) => e.startsWith(sessionId));
    if (hit) {
      foundOnDisk = true;
      foundPath = join(sessionsDir, hit);
      break;
    }
  } catch {
    // sessionsDir may not exist for every project dir
  }
}
console.log(`cwd-md5:    ${cwdHash}`);
console.log(`found:      ${foundOnDisk}`);
if (foundPath) {
  const s = await stat(foundPath);
  console.log(`path:       ${foundPath}`);
  console.log(`size:       ${s.size} bytes`);
}

if (stderrStr.trim().length > 0) {
  console.log("\n=== claude stderr (first 1500 chars) ===");
  console.log(stderrStr.slice(0, 1500));
}

await server.close();
db.close();
console.log("\n[spike] done.");
process.exit(0);
