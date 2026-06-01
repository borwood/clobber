import { z } from "zod";

// #398 habit primitive — the ACTION union (v1 = inject | cli | wake). Reuse-only,
// no bespoke DSL (Golden Rule 1). An action is what fires when a trigger matches.
//
//   inject — return a hint as the /hook receiver's additionalContext, optionally
//            enriched by the stdout of a `bash` command run receiver-side.
//   cli    — fire-and-forget `clobber <verb> [args]` (status / note / finding).
//   wake   — the COMPOSE seam to wake-programs (#212/#213/#214): it SELECTS a
//            program by name, it does not contain one (layered architecture).
//
// Additive-later members (NOT v1), expressed as the union grows:
//   { kind:"broadcast"; targets; payload } — #382 (one → many)
//   { kind:"escalate";  question; chain }  — #384 (up a chain)

export const InjectActionSchema = z.object({
  kind: z.literal("inject"),
  hint: z.string().min(1),
  bash: z.string().min(1).optional(),
});
export type InjectAction = z.infer<typeof InjectActionSchema>;

export const CliActionSchema = z.object({
  kind: z.literal("cli"),
  verb: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type CliAction = z.infer<typeof CliActionSchema>;

export const WakeActionSchema = z.object({
  kind: z.literal("wake"),
  // Defaults to the declaring (self) agent when omitted — the manager self-wake.
  agent: z.string().min(1).optional(),
  // Names a program in the role's wake-programs (or the `idle` built-in).
  wake_program: z.string().min(1).optional(),
  inject: z.string().min(1).optional(),
});
export type WakeAction = z.infer<typeof WakeActionSchema>;

export const HabitActionSchema = z.discriminatedUnion("kind", [
  InjectActionSchema,
  CliActionSchema,
  WakeActionSchema,
]);
export type HabitAction = z.infer<typeof HabitActionSchema>;
