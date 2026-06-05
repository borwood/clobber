import {
  PromptModuleRefsSchema,
  RoleSkillSchema,
  RoleTriggerSchema,
  WakeProgramsSchema,
} from "@clobber/shared";
import { z } from "zod";
import type { RoleVersionSnapshot } from "./role-version-snapshot.ts";
import { canonicalize, type RoleTreeContract } from "./role-tree.ts";

// #348 — bridge between the DB JSON-column snapshot representation (role_versions
// rows) and the in-memory RoleTreeContract the codec works with. Distinct from the
// file-tree serialization/deserialization in role-tree.ts: these converters are
// about the old frozen-column store, not the git-tree layout.

const ToolListSchema = z.array(z.string().min(1));
const TriggersSchema = z.array(RoleTriggerSchema);
const SkillsSchema = z.array(RoleSkillSchema);

export function roleSnapshotToContract(snapshot: RoleVersionSnapshot): RoleTreeContract {
  return canonicalize({
    framing: snapshot.framing,
    systemPrompt: snapshot.system_prompt,
    skills: SkillsSchema.parse(JSON.parse(snapshot.skills_json)),
    allowedTools: ToolListSchema.parse(JSON.parse(snapshot.allowed_tools_json)),
    allowedCliCommands: ToolListSchema.parse(JSON.parse(snapshot.allowed_cli_commands_json)),
    hooks: snapshot.hooks_json,
    triggers: TriggersSchema.parse(JSON.parse(snapshot.triggers_json)),
    seedRefs: PromptModuleRefsSchema.parse(JSON.parse(snapshot.seed_refs_json)),
    wakePrograms: WakeProgramsSchema.parse(JSON.parse(snapshot.wake_programs_json)),
    defaultWakeProgram: snapshot.default_wake_program,
    // Phase 0: habits are git-tree-only; the role-version snapshot has no column.
    habits: [],
  });
}

export function roleContractToSnapshot(contract: RoleTreeContract): RoleVersionSnapshot {
  return {
    framing: contract.framing,
    system_prompt: contract.systemPrompt,
    skills_json: JSON.stringify(contract.skills),
    allowed_tools_json: JSON.stringify(contract.allowedTools),
    allowed_cli_commands_json: JSON.stringify(contract.allowedCliCommands),
    hooks_json: contract.hooks,
    triggers_json: JSON.stringify(contract.triggers),
    seed_refs_json: JSON.stringify(contract.seedRefs),
    wake_programs_json: JSON.stringify(contract.wakePrograms),
    default_wake_program: contract.defaultWakeProgram,
  };
}
