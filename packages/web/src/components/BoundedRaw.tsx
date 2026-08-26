import { useState, type ReactNode } from "react";

export const CAP_CHARS = 10_000;

// Truncates a text payload to CAP_CHARS, with a "show full" button that
// reveals the rest on demand. Used for raw JSON dumps in system/notification/
// tool cards, and (via `render`) for line-oriented views like the diff
// blocks (#684/#687), to prevent OOM/DOM-thrash from MB payloads — every
// consumer shares this ONE truncate/expand implementation rather than
// reimplementing the CAP_CHARS + useState dance per call site.
export function BoundedRaw({
  text,
  className,
  render,
}: {
  text: string;
  className?: string;
  render?: (displayed: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && text.length > CAP_CHARS;
  const displayed = truncated ? text.slice(0, CAP_CHARS) : text;
  return (
    <div>
      {render ? render(displayed) : <pre className={className}>{displayed}</pre>}
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-[10px] text-text-subtle hover:text-text-soft underline"
        >
          show full ({Math.ceil(text.length / 1024)} KB)
        </button>
      )}
    </div>
  );
}
