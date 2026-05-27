import { z } from "zod";

// A wake-program is the opening move of an embodied session (epic #209). It owns
// two channels at session start:
//   system — layer C, a system-prompt addon ("regardless of the first message,
//            do X first"). Composed on every embodiment, including resume.
//   user   — the opening user-message kick, or null for no kick. Fired only on a
//            fresh attach; suppressed on resume (the session already carries its
//            history).
// Wake-programs are role-local: an ordered, versioned JSON list on the role
// version (sibling to seeds/triggers). Forking a role copies them.
export const WakeProgramSchema = z.object({
  name: z.string().min(1),
  system: z.string(),
  user: z.string().min(1).nullable(),
});
export type WakeProgram = z.infer<typeof WakeProgramSchema>;

export const WakeProgramsSchema = z.array(WakeProgramSchema);

// `idle` is the one universal built-in: no layer-C addon, no kick. The agent
// boots fully composed (A+B) and waits for the human on their turn. It is a
// code-level constant — not stored on every role — so selecting it (or selecting
// nothing) yields no C and no kick.
export const IDLE_WAKE_PROGRAM_NAME = "idle";
export const IDLE_WAKE_PROGRAM: WakeProgram = {
  name: IDLE_WAKE_PROGRAM_NAME,
  system: "",
  user: null,
};

// Resolves a selected wake-program by name against a role's program list, with
// `idle` overlaid as the universal built-in. Selecting nothing yields `idle`. A
// name that matches neither the built-in nor a role program is unexpected data
// → throw (no defensive default).
export function resolveWakeProgram(
  programs: readonly WakeProgram[],
  name: string | undefined,
): WakeProgram {
  if (name === undefined || name === IDLE_WAKE_PROGRAM_NAME) return IDLE_WAKE_PROGRAM;
  const program = programs.find((p) => p.name === name);
  if (program === undefined) {
    throw new Error(`role has no wake-program named: ${name}`);
  }
  return program;
}
