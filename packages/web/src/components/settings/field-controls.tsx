import { useState } from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

// Leaf presenters for the schema-driven settings form. Each takes a value and an
// onChange — no field knows its path or the schema; SchemaField wires them.

const INPUT =
  "rounded border border-border bg-surface px-2 py-1 text-xs text-text focus:outline-none focus:border-border-strong";

export function BooleanControl({ value, onChange }: { value: unknown; onChange: (v: boolean) => void }) {
  const on = value === true;
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`px-3 py-1 rounded border text-xs ${
        on ? "border-accent text-text-dim" : "border-border text-text-subtle hover:border-border-strong"
      }`}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

export function StringControl({ value, onChange }: { value: unknown; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT} w-full`}
    />
  );
}

export function NumberControl({ value, onChange }: { value: unknown; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      value={typeof value === "number" ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      className={`${INPUT} w-32`}
    />
  );
}

export function EnumControl({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`px-2.5 py-1 rounded border text-xs capitalize ${
            value === o ? "border-accent text-text-dim" : "border-border text-text-subtle hover:border-border-strong"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function ArrayEnumControl({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: unknown;
  onChange: (v: string[]) => void;
}) {
  const set = new Set(Array.isArray(value) ? (value as string[]) : []);
  function toggle(o: string) {
    const next = new Set(set);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(options.filter((x) => next.has(x)));
  }
  return (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-xs text-text-dim cursor-pointer">
          <input type="checkbox" checked={set.has(o)} onChange={() => toggle(o)} className="accent-accent-strong" />
          <span className="font-mono">{o}</span>
        </label>
      ))}
    </div>
  );
}

export function ArrayStringControl({ value, onChange }: { value: unknown; onChange: (v: string[]) => void }) {
  const list = Array.isArray(value) ? (value as string[]) : [];
  function setAt(i: number, v: string) {
    onChange(list.map((x, j) => (j === i ? v : x)));
  }
  return (
    <div className="flex flex-col gap-1">
      {list.map((item, i) => (
        <div key={i} className="flex gap-1">
          <input type="text" value={item} onChange={(e) => setAt(i, e.target.value)} className={`${INPUT} flex-1`} />
          <button
            type="button"
            onClick={() => onChange(list.filter((_, j) => j !== i))}
            className="px-2 rounded border border-border text-text-subtle hover:text-danger-text text-xs flex items-center"
          >
            <XIcon size={12} weight="bold" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...list, ""])}
        className="self-start px-2 py-0.5 rounded border border-border text-text-subtle hover:border-border-strong text-xs flex items-center gap-1"
      >
        <PlusIcon size={12} weight="bold" /> add
      </button>
    </div>
  );
}

export function StringRecordControl({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: Record<string, string>) => void;
}) {
  const entries = Object.entries((value as Record<string, string>) ?? {});
  function commit(next: [string, string][]) {
    onChange(Object.fromEntries(next));
  }
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-1">
          <input
            type="text"
            value={k}
            placeholder="key"
            onChange={(e) => commit(entries.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
            className={`${INPUT} w-32`}
          />
          <input
            type="text"
            value={v}
            placeholder="value"
            onChange={(e) => commit(entries.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
            className={`${INPUT} flex-1`}
          />
          <button
            type="button"
            onClick={() => commit(entries.filter((_, j) => j !== i))}
            className="px-2 rounded border border-border text-text-subtle hover:text-danger-text text-xs flex items-center"
          >
            <XIcon size={12} weight="bold" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => commit([...entries, ["", ""]])}
        className="self-start px-2 py-0.5 rounded border border-border text-text-subtle hover:border-border-strong text-xs flex items-center gap-1"
      >
        <PlusIcon size={12} weight="bold" /> add
      </button>
    </div>
  );
}

// Last-resort editor for shapes with no structural control (object-valued
// records, free unions). Raw JSON keeps the field on the surface and editable.
export function RawControl({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  function edit(next: string) {
    setText(next);
    try {
      onChange(JSON.parse(next));
      setError(null);
    } catch {
      setError("invalid JSON");
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={text}
        onChange={(e) => edit(e.target.value)}
        spellCheck={false}
        className={`${INPUT} w-full font-mono h-28 resize-y`}
      />
      {error !== null && <span className="text-xs text-danger-text">{error}</span>}
    </div>
  );
}
