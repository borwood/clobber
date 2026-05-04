import { randomBytes, randomUUID } from "node:crypto";

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 4;

export class EmptyLabelSlugError extends Error {
  constructor(public readonly label: string) {
    super("label sanitizes to empty slug");
    this.name = "EmptyLabelSlugError";
  }
}

export function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let out = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

export function deriveSessionId(label: string | undefined): string {
  if (label === undefined) return randomUUID();
  const slug = sanitizeLabel(label);
  if (slug.length === 0) throw new EmptyLabelSlugError(label);
  return `${slug}-${randomSuffix()}`;
}
