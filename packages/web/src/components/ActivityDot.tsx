interface ActivityDotProps {
  readonly busy: boolean;
  readonly intentDot: string;
  readonly hollow?: boolean;
}

// The canonical status dot: a steady dot in the agent's intent color with a
// ping halo while the agent is busy. Shared by the whiteboard cards and the
// transcript tabs so "is this agent active right now" reads identically
// wherever an agent surfaces. `hollow` is the spent state — an ended/gone
// session — drawn as a grey ring with nothing inside, never pinging.
export function ActivityDot({ busy, intentDot, hollow }: ActivityDotProps) {
  if (hollow === true) {
    // Dim ring (text-faint), distinct from the brighter filled zinc dot a
    // done-but-live agent shows — so "spent/ended" reads apart from "finished
    // its turn but still wakeable".
    return (
      <span className="inline-block size-2 rounded-full border border-text-faint" aria-hidden />
    );
  }
  return (
    <span className="relative inline-flex size-2" aria-hidden>
      {busy && (
        <span
          className={`absolute inset-0 rounded-full ${intentDot} opacity-60 animate-ping`}
        />
      )}
      <span className={`relative size-2 rounded-full ${intentDot}`} />
    </span>
  );
}
