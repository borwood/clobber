// Argument helpers shared across the roles read-verbs (roles-inspect.ts) and
// authoring-verbs (roles-edit.ts / roles-seeds.ts / roles-wake-programs.ts).
// Extracted because >=3 verb modules consume them — past the 3-caller bar.

export function takeJsonFlag(args: readonly string[]): {
  readonly json: boolean;
  readonly rest: readonly string[];
} {
  const rest: string[] = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
      continue;
    }
    rest.push(a);
  }
  return { json, rest };
}

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
