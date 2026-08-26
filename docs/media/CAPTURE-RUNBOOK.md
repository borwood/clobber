# Golden-path capture runbook

Real screenshots weren't captured for #686. Reasoning, so the next person
doesn't have to re-derive it:

- The web package (`packages/web`) has no test/browser tooling in the repo
  (no Playwright/Puppeteer dependency, no headless-capture script) — this
  worker's sandbox does have `google-chrome` and network access, so *static*
  page screenshots were technically reachable, but the golden path below
  needs multi-step interaction (fill a form, wait for a real spawned worker
  to hit an ask, wait for it to write a diff, wait for its final report).
  Faking those states without a real running agent would be exactly the
  "broken GIF" the assignment says not to ship.
- Driving the real flow means spawning an actual `claude` session through
  Clobber end to end — real model calls, real wait time for the worker to
  reach an ask and a diff and a report. That's a live-orchestration exercise
  in its own right, not a byproduct of a docs PR, so it's left to whoever
  reviews with a real terminal and a browser attached.
- One scene in the list below (the final report) currently has **no web UI
  surface at all** — `clobber report` writes to the server via CLI
  (`packages/cli/src/commands/report.ts`), but nothing in `packages/web`
  renders it yet (grepped for `report`/`well`/`badly`/`useful` across
  `packages/web/src` — only a schema-introspection test matches). Capture
  that scene as a terminal screenshot of `clobber reports list`, not a UI
  screen, until a web surface exists.

## Environment

- Server: `cd packages/server && bun run dev` (port 3370 by default).
- Web: `cd packages/web && bun run dev` (port 3470 by default).
- A workspace pointed at a throwaway git repo (see README Quickstart for the
  exact `workspace create` call) — reuse that instead of clicking through the
  create-workspace form if you just want the later scenes.
- A **manager** agent installed on the workspace (`clobber agent install
  manager` from an authenticated session, or via the UI's role picker) so the
  first-open interview trigger actually fires.

## Scene list (in order)

1. **Create workspace.** `WorkspaceCreateForm` (top-left workspace switcher →
   "New workspace"). Name + repo path, submit.
2. **Bootstrap interview.** Once the manager's first `workspace-open` wake
   fires (guarded on `.clobber/bootstrap.json` being absent), its
   `AskUserQuestion` call surfaces as an ask widget on the manager's office
   card in the whiteboard pane (center pane, `kind: "whiteboard"`) and in the
   global ask sidebar. Screenshot both the office card mid-ask and the
   sidebar entry.
3. **Floor / whiteboard.** After the interview completes (or is declined),
   the center pane's `WhiteboardView` shows the "Offices" section with the
   manager's card and an empty "Desks at work" section. This is the
   `docs/architecture/agent-model.md` "grid" surface, not the office/kanban
   views described as future work there — caption it as such.
4. **Spawn a worker.** Right pane (`kind: "spawn"`, `SpawnView`): pick the
   `worker` role in `RolePicker`, fill `SpawnPanel` with a real task prompt,
   submit. Screenshot the pane mid-fill and the resulting desk card
   appearing in the whiteboard's "Desks at work" section.
5. **Ask-widget on a worker.** Give the worker a task that forces a `clobber
   ask` or `AskUserQuestion` call (e.g. an ambiguous instruction). Screenshot
   the widget on its desk card and the sidebar mirror, same as step 2 but for
   an ephemeral agent.
6. **Diff-bearing transcript.** Open the worker's session (click its desk
   card, or the left `SessionsView` pane) once it has made an `Edit` or
   `Write` tool call. The transcript renders the unified diff inline
   (`TranscriptBlocks.tsx`, landed in #687) — screenshot the transcript pane
   showing a colored diff block.
7. **Final report.** No web surface exists yet (see above). Screenshot a
   terminal running `clobber reports list` (or `clobber report --well ...
   --badly ... --useful ...` as the worker submits it) instead.

## What to crop into the README

Once captured, the README's "How it feels" section is the natural embed
point — one image per bullet (first-open interview, triggers/asking,
diff transcript). Keep the final-report terminal screenshot out of the README
proper until a real UI surface exists for it; embedding a CLI screenshot next
to browser screenshots would misrepresent it as one product surface.
