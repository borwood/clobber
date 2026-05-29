import type { LoadedRole } from "@clobber/runtime";

export interface RoleVersionSnapshot {
  readonly framing: string;
  readonly system_prompt: string;
  readonly skills_json: string;
  readonly allowed_tools_json: string;
  readonly allowed_cli_commands_json: string;
  readonly hooks_json: string;
  readonly triggers_json: string;
  readonly seed_refs_json: string;
  readonly wake_programs_json: string;
  readonly default_wake_program: string | null;
}

export interface SnapshotInputs {
  readonly loaded: LoadedRole;
  readonly allowedTools: readonly string[];
}

// Project a resolved (base ⊕ fork) role into a role-version field set. The
// effective skills and hooks already live on the LoadedRole — composition
// happened at load time — so this is a pure projection, no bundle re-reads.
// `allowedTools` stays a caller input: a forked or edited role may embody a
// narrower set than the bundle's effective tools.
export function snapshotShippedBundle(inputs: SnapshotInputs): RoleVersionSnapshot {
  const { loaded, allowedTools } = inputs;
  return {
    framing: loaded.framing,
    system_prompt: loaded.systemPrompt,
    skills_json: JSON.stringify(loaded.skills),
    allowed_tools_json: JSON.stringify(allowedTools),
    allowed_cli_commands_json: JSON.stringify([...loaded.manifest.allowedCliCommands]),
    hooks_json: loaded.hooksJson,
    triggers_json: "[]",
    seed_refs_json: JSON.stringify(loaded.manifest.seedRefs ?? []),
    wake_programs_json: JSON.stringify(loaded.manifest.wakePrograms ?? []),
    default_wake_program: loaded.manifest.defaultWakeProgram ?? null,
  };
}
