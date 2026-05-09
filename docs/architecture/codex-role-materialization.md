# Codex Role Materialization

> Status: recommendation from #104 after the initial Codex provider work in
> #102 and startup hardening in #105.

## Recommendation

Use a provider-neutral Clobber contract first:

- role instructions are injected into the Codex prompt as a structured prefix
- the `clobber` CLI is exposed through the existing `.clobber/bin` PATH shim
- per-session auth and workspace context are injected as process environment
  variables
- Codex-native plugins/config/profiles are deferred until there is a stable
  product need and a clear mapping to Clobber role versions

This keeps the manager/worker role APIs consistent across Claude and Codex. The
agent learns the same role contract and calls the same `clobber` CLI, while the
runtime provider owns only how that role contract reaches the underlying agent
runtime.

## Current Codex Mapping

`codexRuntimeProvider` builds prompts in this shape:

```text
<clobber-role-system-prompt>
{role system prompt}
</clobber-role-system-prompt>

{office context, if any}

{user prompt}
```

The process command is:

```sh
codex exec --json --cd <workspace> <prompt>
codex exec resume <provider_thread_id> --json <prompt>
```

For roles using `permission_mode: "bypassPermissions"`, the provider adds
Codex's `--dangerously-bypass-approvals-and-sandbox` flag. Other Clobber
permission modes and `allowed_tools` are retained on the provider request for
auditability, but there is not yet a proven Codex CLI equivalent to Claude's
plugin/tool allowlist surface.

## Environment Contract

The server injects the same session environment for Codex as for Claude:

- `CLOBBER_API_BASE`
- `CLOBBER_SESSION_TOKEN`
- `CLOBBER_SESSION_ID`
- `CLOBBER_WORKSPACE_ID`
- `CLOBBER_ROLE`
- `CLOBBER_OFFICE_DIR` for persistent agents

It also prepends `.clobber/bin` to `PATH`, where the generated `clobber` shim
execs the workspace's checked-out CLI entry. This is the durable agent-to-server
contract; runtime-specific plugin formats should be treated as optional
delivery mechanisms around it.

## Why Not Codex Plugins Yet

The local Codex CLI exposes plugin and profile commands, but `codex exec` does
not currently offer a direct analogue to Claude's `--plugin-dir` plus
`--allowedTools` role bundle surface. Adding a Codex-native materialization
layer now would couple Clobber role versions to a provider-specific format
before the actual semantics are clear.

Prompt-prefix instructions are less elegant than native runtime role support,
but they are explicit, testable, and preserve the modular provider boundary:
core materializes role data once; the provider decides how to present it.

## Fixture

`packages/server/tests/spawn-materialization.test.ts` locks the current
contract for Codex:

- no Claude `pluginDirs` are sent
- the Codex command receives the generated prompt
- role instructions and office context are present in that prompt
- `CLOBBER_*` environment variables and the `.clobber/bin` CLI shim are present

## Follow-Up

Open a dedicated implementation issue only when Codex-native role assets become
necessary. The likely shape is a provider-owned `prepareBundle` variant that
emits Codex-specific instructions/config while preserving the same Clobber role
and CLI environment contract.
