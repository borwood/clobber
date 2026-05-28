import type { ViewId } from "./types.ts";

export const QUICK_ADDS: readonly { readonly view: ViewId; readonly label: string }[] = [
  { view: { kind: "sessions" }, label: "Sessions" },
  { view: { kind: "whiteboard" }, label: "Whiteboard" },
  { view: { kind: "spawn" }, label: "Spawn" },
];
