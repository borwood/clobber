# Spike #367 — is the clobber inject queue redundant with claude's native stdin queue?

**Status: throwaway experiment artifact.** No production change. The remove-vs-keep
decision is the manager's, gated on this evidence (per the #367 brief).

## The question

Does writing a user-prompt to stdin during an open extended-thinking turn actually
poison the message log — given that claude's native stdin queue already defers stdin
writes to safe boundaries?

- **Native safe** → the #360 clobber inject queue is redundant; remove it.
- **Native poisons** → keep the queue, move its dequeue off `Stop` onto a `PostToolUse` flush.

## Method

`run-trial.ts` spawns a **real** `claude` child with clobber's exact wire protocol
(`-p --input-format stream-json --output-format stream-json --include-hook-events`,
plus `--include-partial-messages` and `--replay-user-messages` for observability),
drives it into a long extended-thinking + tool-use turn (an `ultrathink` math puzzle
that must shell out to Bash), and — the instant the first `thinking_delta` streams back
— writes a **RAW** user message straight to stdin, bypassing clobber's inject queue
entirely. It then lets the turn finish, sends a follow-up turn, and inspects claude's
own transcript JSONL for the #360 poison signature (`model:"<synthetic>"` debris +
the `thinking blocks cannot be modified` 400).

`INJECT=0` runs the identical prompt with **no** stdin write — the control.

**24 trials: 14 inject, 10 control.** Inject fired between 3.5s and 13s into thinking
(batch-2 streamed slower under 16-way concurrency).

## Result

| Mode | Trials | Poisoned | Native-deferred the inject |
|------|-------:|---------:|----------------------------|
| inject  | 14 | **1** (~7%)  | **14 / 14** |
| control | 10 | **1** (10%)  | n/a |

Two independent findings, both high-confidence:

### 1. Claude's native stdin queue defers every mid-thinking write — it never poisons.

In **all 14** inject trials the raw write landed in the transcript as a
`queue-operation: enqueue` record *while thinking was streaming*, the assistant turn
then proceeded untouched (thinking → text → tool_use → tool_result …), and the queued
item was released (`remove` / `dequeue`) at a **tool-result boundary** — never inside
the open thinking block. Example (clean inject trial `inj1`):

```
7  queue-op enqueue "Actually, also tell me: what is 17 * 23? ..."   <- raw mid-thinking write
8  assistant [thinking]                                              <- turn continues untouched
9  assistant [text]
10 assistant [tool_use]
11 user      [tool_result]
12 queue-op  remove                                                  <- released at safe boundary
...
24 assistant [text]   (turn completes cleanly, no synthetic debris)
```

This held across inject times from 3.5s to 13s — the deferral is not timing-fragile.

### 2. The "thinking blocks cannot be modified" 400 is INJECT-INDEPENDENT.

The one poisoned **inject** trial (`trial0`) handled its inject *identically* to the
clean trials (enqueue at rec 7, `remove` at rec 18) — and still poisoned. The one
poisoned **control** trial (`ctl2`) poisoned with **no stdin write at all**. Both have
the same structure: a long interleaved `thinking ↔ tool_use` chain, then a trailing
incomplete `thinking` block, then `model:"<synthetic>"` debris and the
`messages.1.content.N: thinking ... blocks in the latest assistant message cannot be
modified` 400.

```
# ctl2 — NO inject — poisoned anyway:
13..23  assistant [thinking]/[tool_use] x N  (interleaved extended thinking + tools)
26      user [tool_result]
27      assistant model=<synthetic> [text]   <- poison debris
```

The poison is a **stochastic property of long interleaved extended-thinking + tool-use
turns** in claude 2.1.154, occurring at ~1/10 *whether or not* anything is written to
stdin. It is exactly what the #360 **repair** half (de-poison on resume) targets — and
it has nothing to do with the inject queue the #360 **prevention** half added.

## Confidence

- **HIGH** that native defers mid-thinking injects safely (14/14, multiple inject timings).
- **HIGH** that the poison is inject-independent (reproduced with zero injects; the one
  poisoned inject handled its inject the same clean way as the 13 non-poisoned injects).
- **MODERATE** on the exact poison *rate* (~8% overall) — small n, and it is a real,
  live, inject-independent bug worth its own issue.

## Recommendation (per the #367 decision tree)

**Native is safe → the clobber inject `prevention` queue is redundant. Remove it;**
`injectPrompt` returns to a direct stdin write, leaning on (a) claude's native stdin
queue for safe mid-turn deferral and (b) the #360 **repair** half for the
inject-independent interleaved-thinking poison.

Two reinforcing points:
- Native dequeues **between actions** (observed at tool-result boundaries), which is
  strictly better than our `Stop`-only flush — removing our queue also eliminates the
  #366 strand class (false-busy → no `Stop` → parked forever).
- The repair half stays load-bearing: it is what actually recovers the
  interleaved-thinking 400, which this spike shows is the real, inject-independent
  poison source.

Not in scope / not retested here: the blocking `clobber ask` round-trip poison
(e3573078 in the #360 forensics) is a different path (blocking waiter, not a plain
stdin inject) and was not exercised by this experiment.

## Reproduce

```bash
cd experiments/spike-367
INJECT=1 bun run run-trial.ts t1   # raw mid-thinking inject
INJECT=0 bun run run-trial.ts c1   # control, no inject
# TRIAL_RESULT <json> on stdout; transcript path is in the json. Costs ~$0.15/trial.
```
