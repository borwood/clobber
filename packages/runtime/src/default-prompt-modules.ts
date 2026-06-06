import type { PromptModule } from "@clobber/shared";

// The prompt-modules clobber ships. These are ordinary catalog entries — no
// engine privilege, no special code path (epic #209 / #211 session-15
// acceptance): a manager-authored module dropped into
// <repo>/.clobber/prompt-modules/ is the same shape and resolves through the
// same composition. A filesystem module of the same name shadows a default
// (see resolvePromptModuleCatalog).
//
//  - office-manifest: a dynamic module that injects the agent's *actual* office
//    and desk paths plus a listing of its office notes, so a woken agent never
//    reconstructs a filesystem layout it should have been told (#211 comment).
//  - repo-sdlc: a static pointer at the repo's conventions.
//  - wisdom-pointer: the migrated #166 boot-context pointer; refed by the
//    manager role alone so workers no longer receive it.
//  - roles-drift-sweep: a dynamic http module injected at compose time (apiBase
//    required); tells a persistent agent how far each workspace role lags behind
//    its upstream default (#401 step-2). Near-silent on zero-drift.
const STATIC_PROMPT_MODULES: readonly PromptModule[] = [
  {
    name: "office-manifest",
    definition: {
      kind: "dynamic",
      provider: {
        kind: "exec",
        command: "sh",
        args: [
          "-c",
          'echo "[Your locations]"; echo "office notes: $CLOBBER_OFFICE_DIR"; echo "desk: $CLOBBER_DESK_DIR"; for f in "$CLOBBER_OFFICE_DIR"/*; do [ -e "$f" ] && echo "- $f"; done; true',
        ],
      },
    },
  },
  {
    name: "repo-sdlc",
    definition: {
      kind: "static",
      text: "[Repo conventions]\nThis repo's SDLC and engineering rules live in CLAUDE.md and the runbooks — read them before implementing.",
    },
  },
  {
    name: "wisdom-pointer",
    definition: {
      kind: "static",
      text: "Behavioral-wisdom log lives at brennan-volter/tasks#20 — consult it when orchestrating, and append to it when you learn something durable about agent behavior.",
    },
  },
];

// When apiBase is provided the roles-drift-sweep module uses a live http
// provider that calls GET /agent/roles/drift-sweep on the running server.
// Without apiBase (e.g. workspace CRUD routes listing the catalog) it
// degrades to noop so the catalog entry is still present for name-based
// shadow detection, just without a live URL.
function buildDriftSweepModule(apiBase?: string): PromptModule {
  return {
    name: "roles-drift-sweep",
    definition: {
      kind: "dynamic",
      provider: apiBase
        ? { kind: "http", url: `${apiBase}/agent/roles/drift-sweep` }
        : { kind: "noop" },
    },
  };
}

export function enumerateDefaultPromptModules(apiBase?: string): readonly PromptModule[] {
  return [...STATIC_PROMPT_MODULES, buildDriftSweepModule(apiBase)];
}
