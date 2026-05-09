# Codex Runtime Spike

> Status: issue #100 spike, promoted into the initial provider in #102.
> Captures observations from `codex-cli 0.129.0` gathered on 2026-05-09.

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

## Initial provider behavior

`codexRuntimeProvider` builds provider-owned command requests instead of
teaching server core about Codex CLI details:

- first turn: `codex exec --json --cd <workspace> <prompt>`
- resume: `codex exec resume <provider_thread_id> --json <prompt>`
- `permission_mode: "bypassPermissions"` maps to
  `--dangerously-bypass-approvals-and-sandbox`
- role `system_prompt` is prepended to the Codex prompt inside a
  `<clobber-role-system-prompt>` block
- stdout is consumed as `codex-jsonl`; `thread.started` updates
  `sessions.provider_thread_id`
- turn-lifetime follow-up prompts wait for provider startup readiness before
  `/sessions/:id/prompt` returns success; early missing-thread failures return
  `410`, while unknown early startup failures return `502`

The server selects this provider with `CLOBBER_RUNTIME_PROVIDER=codex`.
See [Codex Role Materialization](./codex-role-materialization.md) for the
current recommendation on role instructions, CLI environment, and why
Codex-native plugin/config materialization is deferred.

## Provider work still needed

- Decide whether Codex roles should eventually use config/profile, generated
  instructions, native skills, or a combination. The initial provider uses a
  generated prompt prefix and the existing `clobber` PATH shim.
- Expand fixtures with real command execution, approval, failure, and cancelled
  turn shapes before production support.
