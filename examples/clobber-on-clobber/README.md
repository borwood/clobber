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
  it cannot *enable* anything. The manager's `workspace-open` + `cron` triggers live in
  `manager-triggers.json`; leaving `trigger_overrides` empty keeps both active.

## How to load it into a fresh clobber workspace

> `repo_path` in `workspace.config.json` is a placeholder. Replace it with the **absolute path**
> to your clobber checkout before loading.

1. **Create the workspace** from the config — `POST /workspaces` with the file as the body:

   ```sh
   curl -X POST "$CLOBBER_URL/workspaces" \
     -H 'content-type: application/json' \
     --data-binary @examples/clobber-on-clobber/workspace.config.json
   ```

   This seats the manager and applies all four workspace-config primitives.

2. **Give the manager its triggers.** Triggers live on the role-version, not the workspace config,
   so apply `manager-triggers.json` to the manager role via the role-edit seam
   (`PATCH /agent/roles/manager` with `{ "triggers": [...] }`). This is the same self-grant
   mechanism the manager uses for skills (#146/#148); the manager can also do this itself on its
   first wake.

3. **Open the room.** Opening the workspace fires the `workspace-open` trigger
   (`POST /workspaces/:id/open`), waking the manager.

## The manual acceptance loop (what the human walks to verify #150)

With the spawning session out of the loop after manager-wake, you should observe:

1. **Manager wakes on workspace-open** (and thereafter on the daily `cron`).
2. Manager **scans the assigned issues**, picks one, and **briefs you in its office card**.
3. You approve; the manager **forks a `worker`** with the clobber SDLC profile and dispatches it
   via `/assignment <issue numbers>`.
4. The worker **walks the SDLC unattended** and **opens a PR** end-to-end.
5. The worker's **final-report fires the `gh issue create` callback** — a new internal ticket
   appears in `brennan-volter/clobber`.
6. **You review and merge** the PR. The loop closes.

Out of scope for v1 (per #150): the manager merging PRs itself, the manager triaging the tickets
it just filed, and multi-agent fan-out.

## Why two files (a seam note)

clobber has no single "load this directory" command today. A workspace config is ingested by
`POST /workspaces` (`CreateWorkspaceRequest`), but **trigger enablement** and **the worker SDLC
profile** are not part of that shape — triggers live on the role-version (`triggers_json`) and the
SDLC profile lives on the worker role manifest (`sdlc: defaultSdlcProfile`). So this example is
composed from the workspace-config seam **plus** the role-edit seam. A future
`clobber workspace create --config <dir>` loader that ingests a whole example directory in one
step would close that gap; until then, the two-step load above is the honest path.
