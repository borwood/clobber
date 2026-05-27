import type { Seed } from "@clobber/shared";

// The seeds clobber ships. These are ordinary catalog entries — no engine
// privilege, no special code path (epic #209 / #211 session-15 acceptance): a
// manager-authored seed dropped into <repo>/.clobber/seeds/ is the same shape
// and resolves through the same composition. A filesystem seed of the same
// name shadows a default (see resolveSeedCatalog).
//
//  - office-manifest: a dynamic seed that injects the agent's *actual* office
//    and desk paths plus a listing of its office notes, so a woken agent never
//    reconstructs a filesystem layout it should have been told (#211 comment).
//  - repo-sdlc: a static pointer at the repo's conventions.
//  - wisdom-pointer: the migrated #166 boot-context pointer; refed by the
//    manager role alone so workers no longer receive it.
const DEFAULT_SEEDS: readonly Seed[] = [
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

export function enumerateDefaultSeeds(): readonly Seed[] {
  return DEFAULT_SEEDS;
}
