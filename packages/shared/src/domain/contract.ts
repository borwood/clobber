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

// A single monotonic integer for v1 — the contract surfaces above do not
// version independently yet (per-surface versioning is a forward migration if
// they ever diverge). It is its OWN counter, NOT derived from the engine
// semver: most releases do not touch the contract, so deriving from semver
// would lie. Bump this by one ONLY on a contract-affecting change.
export const ENGINE_CONTRACT_VERSION = 1;
