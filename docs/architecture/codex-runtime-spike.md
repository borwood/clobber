# Codex Runtime Spike

> Status: issue #100 spike. Captures observations from `codex-cli 0.129.0`
> gathered on 2026-05-09. This is not a production provider spec yet.

## Observed commands

First turn:

```sh
codex exec --json --cd /tmp --skip-git-repo-check "Reply with exactly: ok"
```

Stdout JSONL:

```jsonl
{"type":"thread.started","thread_id":"019e0b86-a368-7702-9bf3-f5dce89dc9e9"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":13452,"cached_input_tokens":12160,"output_tokens":5,"reasoning_output_tokens":0}}
```

Resume:

```sh
codex exec resume 019e0b86-a368-7702-9bf3-f5dce89dc9e9 --json "Reply with exactly: resumed"
```

Stdout JSONL:

```jsonl
{"type":"thread.started","thread_id":"019e0b86-a368-7702-9bf3-f5dce89dc9e9"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"resumed"}}
{"type":"turn.completed","usage":{"input_tokens":27153,"cached_input_tokens":25344,"output_tokens":11,"reasoning_output_tokens":0}}
```

The emitted `thread_id` is accepted by `codex exec resume`, so it is the
provider thread id Clobber should persist in `sessions.provider_thread_id`.

Codex also writes a persisted transcript under
`~/.codex/sessions/YYYY/MM/DD/rollout-...-<thread_id>.jsonl`. Its first line is
`session_meta` and includes `payload.id`, which matched the stdout `thread_id`
in the observed run.

## Normalization

Runtime-level normalization lives in `packages/runtime/src/codex-jsonl.ts`.
The current spike maps:

| Codex stdout event | Runtime event |
|---|---|
| `thread.started` | `provider-thread-started` |
| `turn.started` | `turn-started` |
| `item.completed` + `item.type = agent_message` | `assistant-message` |
| `item.completed` + function/tool call shape | `tool-call` |
| `item.completed` + function/tool output shape | `tool-result` |
| `turn.completed` | `turn-completed` |
| `turn.failed` / `error` | `turn-failed` |
| unknown/malformed | `unknown` |

Unknown events are preserved instead of dropped. That is intentional while the
Codex stream is still being discovered.

## Recommended provider capabilities

Initial Codex provider capability set:

```ts
{
  processLifetime: "turn",
  livePromptInjection: false,
  interrupt: false,
  resume: true,
}
```

Rationale:

- `codex exec --json` exits after `turn.completed`.
- Omitting `--ephemeral` persists the provider thread but does not keep a live
  process open.
- Follow-up prompts should spawn a fresh `codex exec resume <thread_id> --json`
  run rather than writing to stdin of the previous process.
- There is no observed app-level interrupt protocol for a running turn. The
  viable initial control path is killing the process and resuming with a
  corrective prompt later.

## Provider work still needed

- Implement a real `codexRuntimeProvider` that builds `codex exec --json` and
  `codex exec resume <provider_thread_id> --json` spawn commands.
- Decide how Codex roles are materialized: config/profile, generated prompt
  prefix, skills/plugins, or a combination.
- Add a server path for turn-lifetime providers: prompt injection currently
  assumes a live stdin-backed process.
- Update session state after `provider-thread-started` when
  `provider_thread_id` was unknown at local spawn time.
- Expand fixtures with real command execution, approval, failure, and cancelled
  turn shapes before production support.
