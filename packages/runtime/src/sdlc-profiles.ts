import type { SdlcProfile } from "@clobber/shared";

export const SDLC_PHASES_PLACEHOLDER = "{{SDLC_PHASES}}";

export const defaultSdlcProfile: SdlcProfile = {
  phases: [
    {
      id: "research",
      label: "research",
      description:
        "read the issue + comments, related issues, prior PRs in the same area, and the surrounding code. Write a short orientation note before touching anything.",
    },
    {
      id: "failing-test",
      label: "failing-test",
      description:
        "write the test that demonstrates the bug or the missing feature. Run it. Confirm it fails for the *expected* reason.",
    },
    {
      id: "implement",
      label: "implement",
      description:
        "make the failing test pass. Run the full suite + type-check before declaring done.",
    },
    {
      id: "open-pr",
      label: "open-pr",
      description:
        "branch (worktree if the repo's `CLAUDE.md` says so), commit with conventional-commit messages, push, and open a PR with a structured body (Summary, Test plan, Closes).",
    },
    {
      id: "watch-ci",
      label: "watch-ci",
      description:
        "poll the PR's checks. On red, fetch the failing job's log, attempt a fix, push. On green, finish.",
    },
  ],
  defaultStartingPhase: "research",
  reportCliCommand: "report",
};

export function renderSdlcPhases(profile: SdlcProfile): string {
  return profile.phases
    .map((phase, i) => `${i + 1}. **${phase.label}** — ${phase.description}`)
    .join("\n");
}

export function renderSystemPromptTemplate(
  template: string,
  profile: SdlcProfile | undefined,
): string {
  const hasPlaceholder = template.includes(SDLC_PHASES_PLACEHOLDER);
  if (hasPlaceholder && profile === undefined) {
    throw new Error(
      `system prompt contains ${SDLC_PHASES_PLACEHOLDER} but role manifest has no 'sdlc' profile`,
    );
  }
  if (!hasPlaceholder) return template;
  return template.split(SDLC_PHASES_PLACEHOLDER).join(renderSdlcPhases(profile!));
}
