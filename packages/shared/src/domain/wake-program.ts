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

// Sentinel `user` value meaning "the opening kick is supplied by the caller at
// invocation, not baked into the program". It is the third kick mode (alongside
// a fixed string and `null` for no kick): a program that carries it contributes
// only its layer-C `system`, and the kick falls through to the caller's prompt
// (see `spawn-context.ts`). The only program that uses it is the engine-reserved
// `custom` program; authored programs (human prose) never carry it.
export const CALLER_SUPPLIED_KICK = "<<caller-supplied-kick>>";

// Sentinel `system` value meaning "the layer-C system addon is supplied by the
// caller at invocation". A program carrying it contributes no fixed layer-C text;
// the caller's `systemAddon` (or an empty string if omitted) is used instead.
// Only the engine-reserved `custom` program uses it.
export const CALLER_SUPPLIED_SYSTEM = "<<caller-supplied-system>>";

// `custom` is the second universal built-in (#501): both the kick and the layer-C
// system addon are caller-supplied. custom+prompt → prompt is the opening kick;
// custom+no-prompt → no kick (boot and wait, same as idle). custom+systemAddon →
// the addon composes into layer C; custom+no-systemAddon → no layer-C text.
// In the composer, `custom` subsumes `idle`: an empty custom is equivalent to idle.
export const CUSTOM_WAKE_PROGRAM_NAME = "custom";
export const CUSTOM_WAKE_PROGRAM: WakeProgram = {
  name: CUSTOM_WAKE_PROGRAM_NAME,
  system: CALLER_SUPPLIED_SYSTEM,
  user: CALLER_SUPPLIED_KICK,
};

// The orientation a cycled agent boots with: it shed its predecessor's working
// context on purpose, so its continuity lives in its office notes and the
// handoff brief, not this session's history. Shared by the `cycle` built-in's
// layer-C (legacy cycled sessions, pre-#502) and the cycle operation's op-level
// addon (post-#502); keeping one constant keeps the two injection paths identical.
export const CYCLE_ORIENTATION_LAYER = [
  "You are a freshly-cycled embodiment of this agent. You have NO prior",
  "conversation — your predecessor shed its working context deliberately so",
  "that you start clean. Your continuity does not live in this session's",
  "history; it lives in your office notes and in the handoff brief that",
  "follows as your opening turn. Read your office notes first, then act on the",
  "handoff.",
].join("\n");

// `cycle` is the engine-injected built-in the cycle operation stamped sessions
// with before #502 subsumed it into custom + op-level orientation. It carries
// the orientation as a fixed layer-C `system` and a caller-supplied kick (the
// handoff brief). It is never authored on a role — like `idle` and `custom` it
// is overlaid at resolution time so historical cycled sessions resume cleanly.
export const CYCLE_WAKE_PROGRAM_NAME = "cycle";
export const CYCLE_WAKE_PROGRAM: WakeProgram = {
  name: CYCLE_WAKE_PROGRAM_NAME,
  system: CYCLE_ORIENTATION_LAYER,
  user: CALLER_SUPPLIED_KICK,
};

// Resolves a selected wake-program by name against a role's program list, with
// `idle`, `custom`, and `cycle` overlaid as the universal built-ins. Selecting
// nothing yields `idle`. A name that matches neither a built-in nor a role
// program is unexpected data → throw (no defensive default).
export function resolveWakeProgram(
  programs: readonly WakeProgram[],
  name: string | undefined,
): WakeProgram {
  if (name === undefined || name === IDLE_WAKE_PROGRAM_NAME) return IDLE_WAKE_PROGRAM;
  if (name === CUSTOM_WAKE_PROGRAM_NAME) return CUSTOM_WAKE_PROGRAM;
  if (name === CYCLE_WAKE_PROGRAM_NAME) return CYCLE_WAKE_PROGRAM;
  const program = programs.find((p) => p.name === name);
  if (program === undefined) {
    throw new Error(`role has no wake-program named: ${name}`);
  }
  return program;
}
