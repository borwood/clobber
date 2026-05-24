# clobber-on-clobber — the dogfood workspace config

This is the canonical demo for milestone **#145**: a workspace config built entirely on the
engine primitives that milestone shipped, wired so **clobber manages its own development**.
clobber-the-product == clobber-the-project, so the config lives in this repo without violating
engine/workspace separation.

Every value here is **snapshotted from a proven run** — the role manifests, system prompts, and
SDLC profile already in `packages/runtime/roles/` — not invented from a spec. A spec can be wrong
in ways a working role definition cannot.

## Files

| File | What it is | Schema it satisfies |
|---|---|---|
| `workspace.config.json` | The workspace config the engine consumes | `CreateWorkspaceRequestSchema` (`@clobber/shared`) |
| `manager-triggers.json` | The manager role-version's triggers | `RoleTrigger[]` (`@clobber/shared`) |

These are **two artifacts, not one**, because clobber splits config across two seams (see
[Why two files](#why-two-files-a-seam-note) below).

## The five primitives this config wires

| Primitive | Field | Value here | Issue |
|---|---|---|---|
| Final-report callback | `final_report_callback` | `exec` → `gh issue create` into `brennan-volter/clobber` | #147 |
| Boot-context provider | `boot_context_provider` | `exec` → `echo` a **pointer** to the wisdom log | #166 |
| Trigger overrides | `trigger_overrides` | `{}` — nothing disabled; the manager's triggers stay live | #146 |
| Manager skill policy | `manager_skill_policy` | `allow_self_grant: true`, `allowed_skills: ["clobber-pm"]` | #148 |
| Worker SDLC profile | *(on the worker role)* | the shipped `research → failing-test → implement → open-pr → watch-ci` default | #124 |

A few deliberate choices:

- **`final_report_callback` body comes from stdin.** The engine pipes the final-report payload
  (JSON) to the command's **stdin** — there is no argument templating. That is why the args end
  in `--body-file -`: `gh` reads the issue body from stdin. The new issue's body is the raw
  final-report JSON. (To label these tickets, add `"--label", "internal"` to the args once that
  label exists in the repo.)
- **`boot_context_provider` is a pointer, not a payload.** It echoes a single line telling the
  manager that a behavioral-wisdom log exists at `brennan-volter/tasks#20` and when to reach for
  it — never the log's contents. Always-on full injection was rejected: it taxes every wake.
  Scenario-triggered *consult/capture* skills (the actual log usage) are tracked separately in
  **#178**; when built, those two skills join `allowed_skills`.
- **`trigger_overrides` is empty on purpose.** It is a *disable* map keyed by role-instance id —
  it cannot *enable* anything. The manager's `workspace-open` + `cron` + `session-ended` triggers
  live in `manager-triggers.json`; leaving `trigger_overrides` empty keeps them all active.

## How to load it into a fresh clobber workspace

> `repo_path` in `workspace.config.json` is a placeholder. Replace it with the **absolute path**
> to your clobber checkout before loading.

The loader spans both seams in one command (#181):

```sh
clobber workspace create --config examples/clobber-on-clobber/
```

This reads `workspace.config.json` (→ `POST /workspaces`, seating the manager and applying every
workspace-config primitive) and `manager-triggers.json` (→ `PUT /workspaces/:id/roles/manager/triggers`,
applying the manager's triggers). The worker SDLC profile is the shipped role default — nothing to
load. The two seams it drives are still distinct (see [Why two files](#why-two-files-a-seam-note)).

Then **open the room** to fire the `workspace-open` trigger (`POST /workspaces/:id/open`) and wake
the manager.

## The manual acceptance loop (what the human walks to verify #150)

With the spawning session out of the loop after manager-wake, you should observe:

1. **Manager wakes on workspace-open** (and thereafter on the daily `cron`).
2. Manager **scans the assigned issues**, picks one, and **briefs you in its office card**.
3. You approve; the manager **forks a `worker`** with the clobber SDLC profile and dispatches it
   via `/assignment <issue numbers>`.
4. The worker **walks the SDLC unattended** and **opens a PR** end-to-end.
5. The worker's **final-report fires the `gh issue create` callback** — a new internal ticket
   appears in `brennan-volter/clobber`.
6. **The worker's session end wakes the manager** via the `session-ended` trigger (#171) — no
   polling stopgap needed; the manager reconsiders whether to dispatch the next job.
7. **You review and merge** the PR. The loop closes.

Out of scope for v1 (per #150): the manager merging PRs itself, the manager triaging the tickets
it just filed, and multi-agent fan-out.

## Why two files (a seam note)

A workspace config is ingested by `POST /workspaces` (`CreateWorkspaceRequest`), but **trigger
enablement** and **the worker SDLC profile** are not part of that shape — triggers live on the
role-version (`triggers_json`) and the SDLC profile lives on the worker role manifest
(`sdlc: defaultSdlcProfile`). So this example is composed from the workspace-config seam **plus**
the role-trigger seam. `clobber workspace create --config <dir>` (#181) drives both in one step via
`POST /workspaces` then `PUT /workspaces/:id/roles/manager/triggers` (#186) — it does not collapse
the two artifacts into one, it spans them.
