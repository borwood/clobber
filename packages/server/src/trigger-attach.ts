import type { Agent, ClobberPromptTag, Role, Workspace } from "@clobber/shared";
import type {
  SpawnPipelineSuccess,
  SpawnPipelineNoBundleError,
  SpawnPipelinePromptRequiredError,
} from "./spawn-pipeline.ts";

// The contract a trigger fire uses to materialize a session for an idle agent.
// Shared by the scheduler (which supplies the implementation) and the dispatch
// core (which invokes it).
export type AttachOutcome =
  | SpawnPipelineSuccess
  | SpawnPipelineNoBundleError
  | SpawnPipelinePromptRequiredError;
export type AttachSessionFn = (input: {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
  readonly promptTag?: ClobberPromptTag;
  // The wake-program resolved from the trigger→program mapping (#213). Absent
  // when neither a workspace override nor a role-default maps this trigger —
  // then the synthesized prompt stays the opening kick.
  readonly wakeProgram?: string;
}) => Promise<AttachOutcome>;
