import type { ComponentType } from "react";
import type { FieldNode, NamedField, FieldMeta } from "../../lib/schema-introspect.ts";
import {
  ArrayEnumControl,
  ArrayStringControl,
  BooleanControl,
  EnumControl,
  NumberControl,
  RawControl,
  StringControl,
  StringRecordControl,
} from "./field-controls.tsx";

export interface OverrideProps {
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}
// Path-keyed bespoke editors that pre-empt the structural renderer. Partial: a
// node with no override falls through to its structural control, so siblings of
// an overridden field still render generically.
export type OverrideRegistry = Record<string, ComponentType<OverrideProps>>;

interface Props {
  readonly node: FieldNode;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly overrides: OverrideRegistry;
  readonly path: string;
}

export function SchemaField({ node, value, onChange, overrides, path }: Props) {
  const Override = overrides[path];
  if (Override !== undefined) return <Override value={value} onChange={onChange} />;

  switch (node.kind) {
    case "boolean":
      return <BooleanControl value={value} onChange={onChange} />;
    case "string":
      return <StringControl value={value} onChange={onChange} />;
    case "number":
      return <NumberControl value={value} onChange={onChange} />;
    case "enum":
      return <EnumControl options={node.options} value={value} onChange={onChange} />;
    case "array-enum":
      return <ArrayEnumControl options={node.options} value={value} onChange={onChange} />;
    case "array-string":
      return <ArrayStringControl value={value} onChange={onChange} />;
    case "string-record":
      return <StringRecordControl value={value} onChange={onChange} />;
    case "raw":
      return <RawControl value={value} onChange={onChange} />;
    case "object":
      return <FieldGroup fields={node.fields} value={value} onChange={onChange} overrides={overrides} path={path} />;
    case "union":
      return <UnionField node={node} value={value} onChange={onChange} overrides={overrides} path={path} />;
  }
}

function humanize(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Renders a record/object value as labeled rows. Used both at the top level
// (each patchable field becomes a section) and for nested objects.
function FieldGroup({
  fields,
  value,
  onChange,
  overrides,
  path,
}: {
  fields: readonly NamedField[];
  value: unknown;
  onChange: (next: unknown) => void;
  overrides: OverrideRegistry;
  path: string;
}) {
  const obj = (value as Record<string, unknown>) ?? {};
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => (
        <FieldRow key={f.key} fieldKey={f.key} meta={f.meta}>
          <SchemaField
            node={f.node}
            value={obj[f.key]}
            onChange={(v) => onChange({ ...obj, [f.key]: v })}
            overrides={overrides}
            path={path === "" ? f.key : `${path}.${f.key}`}
          />
        </FieldRow>
      ))}
    </div>
  );
}

function FieldRow({
  fieldKey,
  meta,
  children,
}: {
  fieldKey: string;
  meta: FieldMeta;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-text-dim">{meta.title ?? humanize(fieldKey)}</div>
      {meta.description !== undefined && (
        <div className="text-xs text-text-subtle">{meta.description}</div>
      )}
      <div className="pt-0.5">{children}</div>
    </div>
  );
}

// Discriminated union: a selector over the variant tags, then the selected
// variant's fields written flat into the same { kind, ... } value.
function UnionField({
  node,
  value,
  onChange,
  overrides,
  path,
}: {
  node: Extract<FieldNode, { kind: "union" }>;
  value: unknown;
  onChange: (next: unknown) => void;
  overrides: OverrideRegistry;
  path: string;
}) {
  const current = (value as Record<string, unknown>) ?? {};
  const tag = current[node.discriminator] as string | undefined;
  const variant = node.variants.find((v) => v.tag === tag);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {node.variants.map((v) => (
          <button
            key={v.tag}
            type="button"
            onClick={() => onChange({ [node.discriminator]: v.tag })}
            className={`px-2.5 py-1 rounded border text-xs ${
              tag === v.tag ? "border-accent text-text-dim" : "border-border text-text-subtle hover:border-border-strong"
            }`}
          >
            {v.tag}
          </button>
        ))}
      </div>
      {variant !== undefined && variant.fields.length > 0 && (
        <div className="pl-3 border-l border-border">
          <FieldGroup
            fields={variant.fields}
            value={current}
            onChange={onChange}
            overrides={overrides}
            path={path}
          />
        </div>
      )}
    </div>
  );
}
