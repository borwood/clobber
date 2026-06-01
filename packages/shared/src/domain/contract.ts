// The engine↔role contract — the single source of truth for which engine
// surfaces a frozen RoleVersion depends on, and the monotonic version that
// stamps each one.
//
// A RoleVersion (`role.ts`) freezes contract-bearing JSON: `hooks_json`,
// `triggers_json`, `allowed_tools_json`, `allowed_cli_commands_json`,
// `system_prompt`, `seed_refs_json`, `wake_programs_json`,
// `default_wake_program`. Every one of those encodes a piece of the
// engine↔role contract enumerated below. A row authored under one engine
// contract is a frozen snapshot of contract-dependent data; without a stamp
// recording which contract authored it, no later engine can reason about
// whether the pinned role still means what it meant. The stamp is the
// foundational primitive the compat check (#237) and forward migrations
// (#238) build on.
//
// The contract surface (enumerated; re-trace before changing a surface):
//   - Hook event kinds + payload shapes — `hooks/payloads.ts`.
//   - Trigger kinds — the `RoleTrigger` discriminated union in `role.ts`.
//   - The sdlc profile schema + permission mode — `SdlcProfile` in `role.ts`,
//     `permissionMode`/`sdlc` in `role-manifest.ts`, `PermissionMode` in
//     `hooks/payloads.ts`.
//   - Tool/cli allowlist semantics — `isCliCommandAllowed` in
//     `role-manifest.ts` and the `allowed_*_json` columns.
//   - The workspace contracts a role invokes — `boot_context_provider` and
//     `final_report_callback` in `workspace.ts`.
//   - Self-habits — the `Habit` schema in `habit.ts` and the self.* → Claude
//     event mapping in `compile-self-habits.ts`. Habits are git-tree-only
//     (file-per-habit, #398/#407): NOT a frozen `role_versions` column, so they
//     reach the engine through the materialized `RoleTreeContract` cache, not the
//     version-row JSON. Adding the field (#408/#409) reshaped that contract — the
//     cache row gained a `habits` key — which is why it was a contract-affecting
//     change even though no version column moved.

// A monotonic integer — the contract surfaces above do not version independently
// yet (per-surface versioning is a forward migration if they ever diverge). It is
// its OWN counter, NOT derived from the engine semver: most releases do not touch
// the contract, so deriving from semver would lie. Bump this by one ONLY on a
// contract-affecting change.
//   - v1: the original frozen surface.
//   - v2: `habits` (#408/#409) — the field added to the role contract surface
//     without a bump, which left the #430 cache gate inert and re-crashed resume
//     on pre-habits rows (#432).
export const ENGINE_CONTRACT_VERSION = 2;
