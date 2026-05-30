// Spike #367 — does a RAW mid-extended-thinking stdin write poison claude's log?
//
// Spawns a real `claude` child with the same wire protocol clobber uses
// (`-p --input-format stream-json --output-format stream-json`), drives it into
// a long extended-thinking + tool-use turn, and — the instant the first
// `thinking_delta` streams back — writes a RAW user message straight to stdin,
// bypassing clobber's inject queue entirely. We are testing claude's NATIVE
// behavior: does its own stdin queue defer the write to a safe boundary, or
// does the write land inside the open thinking block and poison the transcript?
//
// After the turn completes we send a follow-up turn and watch for the API 400
// ("thinking blocks in the latest assistant message cannot be modified"), then
// inspect the on-disk transcript JSONL for the #360 poison signature.
//
// Usage: bun run-trial.ts <trialIndex>
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const trialIndex = process.argv[2] ?? "0";
// INJECT=0 → control run: same prompt, never write the mid-thinking inject.
const doInject = process.env.INJECT !== "0";

function deriveTranscriptPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9-]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

function userMessage(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

const sessionId = randomUUID();
const cwd = mkdtempSync(join(tmpdir(), `spike367-cwd-${trialIndex}-`));
const logDir = join("/tmp/spike367/logs");
mkdirSync(logDir, { recursive: true });
const stdoutLog = join(logDir, `trial-${trialIndex}-stdout.jsonl`);
const stdoutLines: string[] = [];

// A prompt that reliably opens a LONG extended-thinking + tool-use turn:
// ultrathink keyword maximizes the thinking budget, the task is a genuinely
// hard multi-step reasoning problem, and it must shell out to Bash so the turn
// is "extended-thinking + tool-use" exactly as the brief specifies.
const INITIAL_PROMPT = [
  "ultrathink about this carefully before doing anything.",
  "I need you to reason step by step, at length, about the following puzzle,",
  "then verify your reasoning by running shell commands with the Bash tool.",
  "",
  "Puzzle: Find the smallest positive integer N such that N, N+1, and N+2 are",
  "each divisible by a distinct perfect square greater than 1 (i.e. three",
  "consecutive integers each divisible by a different square > 1). Reason about",
  "why such a run must exist, derive candidate ranges by hand FIRST (think hard",
  "and show all your reasoning before touching the shell), then write a Bash",
  "one-liner (using seq/factor or a small awk/python) to confirm the answer and",
  "print the three numbers and their square factors.",
].join("\n");

// The raw mid-thinking inject — a plain user turn, exactly what clobber's
// `live.stdin.write(serializeUserPrompt(...))` would emit if it did NOT queue.
const MID_THINKING_INJECT = userMessage(
  "Actually, also tell me: what is 17 * 23? Answer inline when you can.",
);

const FOLLOWUP = userMessage("Thanks. Now, in one sentence, restate the final answer to the puzzle.");

const args = [
  "--session-id", sessionId,
  "--permission-mode", "bypassPermissions",
  "--allowedTools", "Bash,Read",
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--include-hook-events",
  "--replay-user-messages",
  "--verbose",
];

// Strip CLOBBER_* so the throwaway child is fully independent of this session
// (no shared token, no hook callbacks into the clobber server).
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("CLOBBER_")) env[k] = v;
}

const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
let injected = false;
let injectTimeMs = 0;
let firstThinkingMs = 0;
const startMs = Date.now();
const queueOps: Array<{ op: string; ms: number }> = [];
let sawThinkingBlocks400 = false;
const errorLines: string[] = [];
let turnsCompleted = 0;
let followupSent = false;
let firstTurnError = false;
let followupError = false;

function now(): number {
  return Date.now() - startMs;
}

function handleEvent(obj: any): void {
  const type = obj?.type;

  // Native stdin queue is observable as queue-operation records.
  if (type === "queue-operation" || obj?.operation === "enqueue" || obj?.operation === "dequeue") {
    queueOps.push({ op: obj.operation ?? type, ms: now() });
  }

  // Partial-message stream: fire the inject on the FIRST thinking delta.
  if (type === "stream_event") {
    const ev = obj.event;
    const isThinkingStart =
      ev?.type === "content_block_start" && ev?.content_block?.type === "thinking";
    const isThinkingDelta =
      ev?.type === "content_block_delta" && ev?.delta?.type === "thinking_delta";
    if ((isThinkingStart || isThinkingDelta) && !injected && firstThinkingMs === 0) {
      firstThinkingMs = now();
      if (doInject) {
        // RAW mid-thinking write — bypassing clobber's queue.
        child.stdin.write(MID_THINKING_INJECT);
        injected = true;
        injectTimeMs = now();
      }
    }
  }

  // Capture API/error surfacing (only real errors — not the benign
  // `thinking_tokens` budget pings, which merely contain the substring "400").
  if (type === "result") {
    turnsCompleted += 1;
    const isErr = obj.is_error === true || typeof obj.api_error_status === "number";
    if (turnsCompleted === 1) firstTurnError = isErr;
    if (turnsCompleted === 2) followupError = isErr;
    if (isErr) {
      errorLines.push(`turn ${turnsCompleted} is_error: ${JSON.stringify(obj).slice(0, 400)}`);
    }
    // After the FIRST turn completes, send the follow-up to probe for the 400.
    if (turnsCompleted === 1 && !followupSent) {
      followupSent = true;
      child.stdin.write(FOLLOWUP);
    }
    // After the second turn (follow-up) completes, close stdin to end session.
    if (turnsCompleted >= 2) {
      child.stdin.end();
    }
  }

  // The thinking-blocks 400 is the smoking gun for the #360 poison.
  const raw = JSON.stringify(obj);
  if (raw.includes("cannot be modified") || raw.includes("thinking` or `redacted_thinking")) {
    sawThinkingBlocks400 = true;
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length === 0) continue;
    stdoutLines.push(line);
    try {
      handleEvent(JSON.parse(line));
    } catch {
      // non-JSON line — keep in the log, ignore for control flow
    }
  }
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c: string) => (stderr += c));

// Kick off the turn.
child.stdin.write(userMessage(INITIAL_PROMPT));

// Safety timeout: if the session never ends, kill it so the trial terminates.
const killTimer = setTimeout(() => {
  errorLines.push("TIMEOUT: killing child after 240s");
  child.kill("SIGKILL");
}, 240_000);

await new Promise<void>((resolve) => child.on("close", () => resolve()));
clearTimeout(killTimer);

writeFileSync(stdoutLog, stdoutLines.join("\n") + "\n");

// ---- Inspect the on-disk transcript for the #360 poison signature ----
const transcriptPath = deriveTranscriptPath(cwd, sessionId);
let poisonReport = "transcript missing";
if (existsSync(transcriptPath)) {
  const rawLines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.length > 0);
  const parsed = rawLines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return {};
    }
  });
  let syntheticCount = 0;
  let trailingIncompleteThinking = false;
  for (const p of parsed) {
    if (p?.message?.model === "<synthetic>") syntheticCount += 1;
  }
  // Trailing-incomplete-thinking check: walk back from the tail.
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i]?.message;
    if (!m || m.role !== "assistant" || m.model === "<synthetic>") {
      if (parsed[i]?.message?.model === "<synthetic>") continue;
      // a user/tool_result turn — clean-ish boundary, stop
      if (m?.role === "user") break;
      continue;
    }
    const content = m.content;
    const last = Array.isArray(content) ? content[content.length - 1] : null;
    const t = last?.type;
    if (t === "text") break;
    if (t === "thinking" || t === "tool_use") {
      trailingIncompleteThinking = true;
      break;
    }
  }
  poisonReport = JSON.stringify({
    records: parsed.length,
    syntheticErrorRecords: syntheticCount,
    trailingIncompleteThinking,
    poisoned: syntheticCount > 0,
  });
}

const summary = {
  trial: trialIndex,
  mode: doInject ? "inject" : "control",
  sessionId,
  cwd,
  transcriptPath,
  injected,
  firstThinkingMs,
  injectTimeMs,
  turnsCompleted,
  followupSent,
  firstTurnError,
  followupError,
  sawThinkingBlocks400,
  queueOps,
  errorLines: errorLines.slice(0, 6),
  stderrTail: stderr.slice(-300),
  poison: poisonReport,
};
console.log("TRIAL_RESULT " + JSON.stringify(summary));
