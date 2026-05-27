import type { Agent, Role, Workspace } from "@clobber/shared";
import type { SpawnPipelineSuccess, SpawnPipelineNoBundleError } from "./spawn-pipeline.ts";

// The contract a trigger fire uses to materialize a session for an idle agent.
// Shared by the scheduler (which supplies the implementation) and the dispatch
// core (which invokes it).
export type AttachOutcome = SpawnPipelineSuccess | SpawnPipelineNoBundleError;
export type AttachSessionFn = (input: {
  readonly workspace: Workspace;
  readonly role: Role;
  readonly agent: Agent;
  readonly prompt: string;
}) => Promise<AttachOutcome>;
