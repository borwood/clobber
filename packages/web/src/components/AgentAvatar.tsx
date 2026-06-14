import { useMemo } from "react";
import { minidenticon } from "minidenticons";

interface AgentAvatarProps {
  // Identicon cell pattern is seeded by the label; hue family by the role.
  readonly label: string;
  readonly role: string;
  // The agent's status color as a Tailwind `bg-*` token (from state-tones).
  readonly statusBg: string;
  readonly busy: boolean;
  // Ended/dead session — desaturate the identicon so it reads as spent.
  readonly muted: boolean;
}

// Literal border tokens for each status fill — Tailwind's JIT only emits classes
// it sees verbatim in source, so the matching border-* can't be string-derived.
const STATUS_BORDER: Record<string, string> = {
  "bg-working": "border-working",
  "bg-blocked": "border-blocked",
  "bg-text-muted": "border-text-muted",
  "bg-info": "border-info",
  "bg-text-faint": "border-text-faint",
};

// minidenticon's own hash (mirrored so we can recombine its two channels): the
// low 15 bits drive which cells fill (the pattern); `hash % 9` drives the hue.
const MAGIC = 5;
function simpleHash(str: string): number {
  return str.split("").reduce((h, c) => (h ^ c.charCodeAt(0)) * -MAGIC, MAGIC) >>> 2;
}

// Blend two identities: pattern from the label, hue family from the role. 0x8000
// ≡ -1 (mod 9), so adding 0x8000·k shifts the hue without touching the low 15
// pattern bits — pick k that lands the role's hue while preserving the pattern.
function blendedHash(label: string, role: string): number {
  const pattern = simpleHash(label) & 0x7fff;
  const hue = simpleHash(role) % 9;
  const k = (((pattern - hue) % 9) + 9) % 9;
  return pattern + 0x8000 * k;
}

// Square identicon avatar for the transcript header — replaces the status dot.
// Both colors derive from the agent's hue (pattern from label, hue from role):
// the cells and the background share the hue at two lightnesses, read from the
// `--pfp-*-l` CSS vars so dark/light themes flip which one is darker. A status-
// colored border + busy ping halo carry live state. Inlined (not an <img>) so the
// cell fill can reference those theme vars and the saturate fade reaches the cells.
export function AgentAvatar({ label, role, statusBg, busy, muted }: AgentAvatarProps) {
  const statusBorder = STATUS_BORDER[statusBg];
  const { svg, fill } = useMemo(() => {
    const hash = blendedHash(label, role);
    const hue = (hash % 9) * 40;
    const svg = minidenticon(label, 50, 75, () => hash)
      .replace("<svg ", '<svg width="100%" height="100%" ')
      .replace(/fill="hsl\([^"]*\)"/, `fill="hsl(${hue} 50% var(--pfp-cell-l))"`);
    return { svg, fill: `hsl(${hue} 50% var(--pfp-fill-l))` };
  }, [label, role]);
  return (
    <span className="relative inline-flex size-[var(--pfp-size,50px)]" aria-hidden>
      {busy && (
        <span className={`absolute inset-0 -z-10 rounded ${statusBg} opacity-60 animate-ping-pad`} />
      )}
      <span
        style={{ backgroundColor: fill }}
        dangerouslySetInnerHTML={{ __html: svg }}
        className={`relative inline-flex h-full w-full overflow-hidden rounded border-4 transition duration-500 ease-out ${statusBorder} p-0.5 ${muted ? "saturate-25" : ""}`}
      />
    </span>
  );
}
