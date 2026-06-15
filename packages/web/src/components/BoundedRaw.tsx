import { useState } from "react";

const CAP_CHARS = 10_000;

// Renders a pre-formatted text payload truncated to CAP_CHARS, with a
// "show full" button that reveals the rest on demand. Used for raw JSON
// dumps in system/notification/tool cards to prevent OOM from MB payloads.
export function BoundedRaw({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && text.length > CAP_CHARS;
  const displayed = truncated ? text.slice(0, CAP_CHARS) : text;
  return (
    <div>
      <pre className={className}>{displayed}</pre>
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
