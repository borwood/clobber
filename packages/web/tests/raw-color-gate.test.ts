import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

// The completeness "checked bit" for the semantic-token migration (#368). Every
// color in the web UI must be expressed as a semantic role token, not a raw
// Tailwind palette utility — otherwise a missed class stays hard-coded and
// silently won't theme. This gate scans the source tree for raw palette
// utilities of any family/shade and fails if one survives. The token-definition
// file (index.css) is the single sanctioned place a literal color may appear.

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WEB, "src");

// Tailwind's full default palette. Listing every family (not just the four the
// UI happens to use today) means a future `bg-blue-500` fails the gate too.
const PALETTE = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose", "slate", "gray", "zinc", "neutral", "stone",
].join("|");

// A raw palette utility is `<prefix>-<family>-<shade>[/<alpha>]`. The leading
// `-` anchors to a utility segment, so directional borders (`border-l-amber-500`)
// and state variants (`hover:` + a bg utility) are caught, while a bare mention
// of a shade in prose (a family-shade with no leading dash) is not.
const RAW_COLOR_RE = new RegExp(
  `-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d{1,3})?\\b`,
  "g",
);

// The token-definition file is exempt; it is where literal colors are allowed
// to live. Everything else in src/ must go through the semantic utilities.
const EXEMPT = new Set(["index.css"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(root: string, glob: string, prefix: string, out: Violation[]) {
  for (const rel of new Glob(glob).scanSync(root)) {
    if (EXEMPT.has(rel)) continue;
    const content = require("node:fs").readFileSync(join(root, rel), "utf8");
    content.split("\n").forEach((line: string, i: number) => {
      for (const m of line.matchAll(RAW_COLOR_RE)) {
        out.push({ file: prefix + rel, line: i + 1, text: m[0] });
      }
    });
  }
}

function scanRawColors(): Violation[] {
  const violations: Violation[] = [];
  scan(SRC, "**/*.{ts,tsx,css}", "src/", violations);
  // The Vite entry document carries the root bg/text classes — themeable too.
  scan(WEB, "index.html", "", violations);
  return violations;
}

describe("raw-color lint gate (#368)", () => {
  it("flags a deliberately-added raw palette utility and ignores semantic ones", () => {
    // Built by concatenation so Tailwind's content scanner doesn't treat these
    // literals as real utilities and emit dead CSS rules for them.
    const raw = (s: string) => `bg-${s}`;
    expect(raw("zinc-900").match(RAW_COLOR_RE)).not.toBeNull();
    expect(`hover:bg-${"amber-900"}/60`.match(RAW_COLOR_RE)).not.toBeNull();
    expect(`border-l-${"emerald-500"}`.match(RAW_COLOR_RE)).not.toBeNull();
    expect("bg-surface".match(RAW_COLOR_RE)).toBeNull();
    expect("text-provenance border-border-strong".match(RAW_COLOR_RE)).toBeNull();
  });

  it("no raw palette color utilities remain in packages/web/src", () => {
    const violations = scanRawColors();
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    expect(
      violations,
      `Raw palette utilities must be migrated to semantic tokens (#368):\n${report}`,
    ).toEqual([]);
  });
});
