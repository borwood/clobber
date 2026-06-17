// Schema → form descriptor. Walks a Zod 4 schema's runtime def and projects it
// into a normalized FieldNode tree the renderer paints by rule. The canonical
// workspace schema stays the single source (GR6): a new field appears in the
// settings UI the moment it lands in the schema, with no UI edit.
//
// Zod 4 runtime shape (verified): every schema carries `_zod.def` with a `type`
// tag; wrappers (`optional`, `default`) nest the real schema under `innerType`;
// objects expose `shape`; arrays `element`; records `keyType`/`valueType`;
// discriminated unions `discriminator` + `options`; enums `entries`; literals
// `values`. `.meta()` returns registry copy.

export interface FieldMeta {
  readonly title?: string;
  readonly description?: string;
}

export interface NamedField {
  readonly key: string;
  readonly meta: FieldMeta;
  readonly node: FieldNode;
}

export interface UnionVariant {
  readonly tag: string;
  readonly fields: readonly NamedField[];
}

export type FieldNode =
  | { readonly kind: "boolean" }
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "enum"; readonly options: readonly string[] }
  | { readonly kind: "array-enum"; readonly options: readonly string[] }
  | { readonly kind: "array-string" }
  | { readonly kind: "string-record" }
  | { readonly kind: "object"; readonly fields: readonly NamedField[] }
  | {
      readonly kind: "union";
      readonly discriminator: string;
      readonly variants: readonly UnionVariant[];
    }
  // Escape hatch for shapes with no honest structural control yet (object-valued
  // records, free unions). Renders as a raw JSON editor so nothing ever silently
  // disappears from the surface (GR7 — coverage can't fail).
  | { readonly kind: "raw" };

// Minimal structural views over Zod 4's runtime def. `any` is the honest type
// here — we are deliberately reading library internals through the one shape the
// probe proved stable.
type ZodDef = { readonly type: string } & Record<string, unknown>;
type ZodLike = { readonly _zod?: { readonly def: ZodDef }; readonly def?: ZodDef };

function defOf(schema: unknown): ZodDef {
  const s = schema as ZodLike;
  const d = s._zod?.def ?? s.def;
  if (d === undefined) throw new Error("not a zod schema");
  return d;
}

// Strip transparent wrappers (optional/default) to reach the meaningful schema.
function unwrap(schema: unknown): unknown {
  let cur = schema;
  for (;;) {
    const d = defOf(cur);
    if (d.type === "optional" || d.type === "default") {
      cur = d.innerType;
      continue;
    }
    return cur;
  }
}

function readMeta(schema: unknown): FieldMeta {
  let cur = schema;
  for (;;) {
    const meta = (cur as { meta?: () => FieldMeta | undefined }).meta?.();
    if (meta !== undefined && (meta.title !== undefined || meta.description !== undefined)) {
      return meta;
    }
    const d = defOf(cur);
    if (d.type === "optional" || d.type === "default") {
      cur = d.innerType;
      continue;
    }
    return {};
  }
}

function shapeOf(d: ZodDef): Record<string, unknown> {
  const shape = d.shape;
  return typeof shape === "function" ? (shape as () => Record<string, unknown>)() : (shape as Record<string, unknown>);
}

function enumOptions(d: ZodDef): readonly string[] {
  return Object.values(d.entries as Record<string, string>);
}

function namedFields(shape: Record<string, unknown>, skip?: string): readonly NamedField[] {
  return Object.entries(shape)
    .filter(([key]) => key !== skip)
    .map(([key, fieldSchema]) => ({
      key,
      meta: readMeta(fieldSchema),
      node: describeSchema(fieldSchema),
    }));
}

function variantsOf(d: ZodDef): readonly UnionVariant[] {
  const discriminator = d.discriminator as string;
  return (d.options as unknown[]).map((opt) => {
    const shape = shapeOf(defOf(opt));
    const tag = (defOf(shape[discriminator]).values as unknown[])[0] as string;
    return { tag, fields: namedFields(shape, discriminator) };
  });
}

export function describeSchema(schema: unknown): FieldNode {
  const s = unwrap(schema);
  const d = defOf(s);
  switch (d.type) {
    case "boolean":
      return { kind: "boolean" };
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "enum":
      return { kind: "enum", options: enumOptions(d) };
    case "object":
      return { kind: "object", fields: namedFields(shapeOf(d)) };
    case "array": {
      const el = defOf(unwrap(d.element));
      if (el.type === "enum") return { kind: "array-enum", options: enumOptions(el) };
      if (el.type === "string") return { kind: "array-string" };
      return { kind: "raw" };
    }
    case "record": {
      const vt = defOf(unwrap(d.valueType));
      return vt.type === "string" ? { kind: "string-record" } : { kind: "raw" };
    }
    case "union":
      return d.discriminator === undefined
        ? { kind: "raw" }
        : { kind: "union", discriminator: d.discriminator as string, variants: variantsOf(d) };
    default:
      return { kind: "raw" };
  }
}
